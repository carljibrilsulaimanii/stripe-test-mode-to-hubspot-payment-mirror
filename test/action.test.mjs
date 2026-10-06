// action.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-10-06
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs workflow-action/stripe-test-mirror-action.js in a sandbox with the
//          HubSpot client and Stripe faked, checking the live-mode guard, the
//          upsert key, unit conversion and the Checkout Session fallback.
// Why:     A wrong guard files live payments as test data; a wrong key duplicates
//          rows on every Stripe retry.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../workflow-action/stripe-test-mirror-action.js', import.meta.url), 'utf8');

function event(overrides = {}) {
  return {
    inputFields: {
      pi_id: 'pi_test_1',
      amount: '3699',
      amount_received: '3699',
      amount_capturable: '0',
      currency: 'usd',
      status: 'succeeded',
      created: '1789000000',
      description: '',
      receipt_email: '',
      customer_id: 'cus_test',
      capture_method: 'automatic',
      confirmation_method: 'automatic',
      payment_method: 'pm_test',
      payment_method_types: '["card"]',
      statement_descriptor: '',
      charges_json: JSON.stringify([{ billing_details: { name: 'Alex Rivera', email: 'alex@example.com' } }]),
      livemode: 'false',
      event_type: 'payment_intent.succeeded',
      ...overrides,
    },
  };
}

async function run(evt, { session = null, env = {} } = {}) {
  const upserts = [];
  const stripeCalls = [];
  class Client {
    constructor(opts) { this.token = opts.accessToken; }
    async apiRequest(req) {
      upserts.push(JSON.parse(JSON.stringify(req)));
      return { json: async () => ({ results: [{ id: 'rec-1' }] }) };
    }
  }
  const ctx = {
    exports: {},
    require: (name) => {
      assert.equal(name, '@hubspot/api-client');
      return { Client };
    },
    process: { env: { HUBSPOT_MIRROR_TOKEN: 'pat-test', STRIPE_TEST_KEY: 'sk_test_x', ...env } },
    fetch: async (url) => {
      stripeCalls.push(String(url));
      return { ok: true, json: async () => ({ data: session ? [session] : [] }) };
    },
    encodeURIComponent,
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  const out = await new Promise((resolve, reject) => ctx.exports.main(evt, resolve).catch(reject));
  return { out: JSON.parse(JSON.stringify(out.outputFields)), upserts, stripeCalls };
}

test('a test payment is upserted on test_txn_key and marked Test', async () => {
  const { out, upserts } = await run(event());
  assert.equal(out.recordId, 'rec-1');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].path, '/crm/v3/objects/2-12345678/batch/upsert');
  const input = upserts[0].body.inputs[0];
  assert.equal(input.idProperty, 'test_txn_key');
  assert.equal(input.id, 'pi_test_1');
  assert.equal(input.properties.record_environment, 'Test');
  assert.equal(input.properties.stripe_payment_transaction_id, 'pi_test_1');
});

test('amounts become dollars and seconds become milliseconds', async () => {
  const { upserts } = await run(event());
  const p = upserts[0].body.inputs[0].properties;
  assert.equal(p.amount, 36.99);
  assert.equal(p.amount_capturable, 0);
  assert.equal(p.created, 1789000000000);
  assert.equal(p.allowed_payment_methods, 'card');
});

test('billing details come from the charge, with no Stripe call when complete', async () => {
  const { upserts, stripeCalls } = await run(event({ description: 'Set by Stripe' }));
  const p = upserts[0].body.inputs[0].properties;
  assert.equal(p.customer_name, 'Alex Rivera');
  assert.equal(p.customer_email, 'alex@example.com');
  assert.equal(p.receipt_email, 'alex@example.com');
  assert.equal(stripeCalls.length, 0);
});

test('a blank description is rebuilt from the Checkout Session line items', async () => {
  const session = {
    customer_details: { name: 'Alex Rivera', email: 'alex@example.com' },
    line_items: { data: [
      { description: 'Starter Kit', amount_total: 3699 },
      { description: 'Program - Pay In Full - $1497', amount_total: 149700 },
    ] },
  };
  const { upserts, stripeCalls } = await run(event(), { session });
  assert.equal(stripeCalls.length, 1);
  assert.ok(stripeCalls[0].includes('payment_intent=pi_test_1'));
  assert.equal(upserts[0].body.inputs[0].properties.description, 'Starter Kit ($36.99) + Program - Pay In Full - $1497');
});

test('a live event is skipped and nothing is written', async () => {
  const { out, upserts } = await run(event({ livemode: 'true' }));
  assert.equal(out.skipped, 'livemode');
  assert.equal(upserts.length, 0);
});

test('a live Stripe key is never used for the session lookup', async () => {
  const { stripeCalls } = await run(event(), { env: { STRIPE_TEST_KEY: 'rk_live_x' } });
  assert.equal(stripeCalls.length, 0);
});

test('an event with no PaymentIntent id fails loudly', async () => {
  await assert.rejects(run(event({ pi_id: '' })), /No PaymentIntent ID/);
});
