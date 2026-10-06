// stripe-test-mirror-action.js
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Date:    2026-08-26 (published 2026-10-06)
// Deploy:  HubSpot workflow custom code action (Node.js 20.x), the only action in a
//          workflow triggered by a Stripe sandbox/test-mode `payment_intent.succeeded`
//          webhook event (README Steps 3-5). Paste the whole file.
// What:    Writes each Stripe TEST payment into the same HubSpot object that HubSpot's
//          Stripe Data Sync fills with live payments, marked Record Environment = Test
//          and keyed on its own unique Test Txn Key.
// Why:     Data Sync reads live Stripe data only, so test payments never reach
//          HubSpot - and nothing downstream (product names, routing, conversions) can
//          be tested without a real charge.
// ---------------------------------------------------------------------------

const hubspot = require('@hubspot/api-client');

// The object HubSpot's Stripe Data Sync writes live payments into (README Step 1).
const OBJECT_TYPE = '2-12345678';

// Verified against live rows: Data Sync stores dollars (a starter kit reads 36.99,
// not 3699), so Stripe's minor units get divided by 100.
const AMOUNTS_IN_CENTS = false;

// Stripe sends epoch seconds; HubSpot datetime properties want epoch millis.
const toTimestamp = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) * 1000 : undefined;
};

// Stripe reports the smallest currency unit — 149700 is $1,497.00.
const toAmount = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return AMOUNTS_IN_CENTS ? Math.trunc(n) : n / 100;
};

// On API version 2017-08-15 the whole charge arrives as a JSON string, so billing
// details come free — no second call to Stripe.
const firstCharge = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed[0] : null;
  } catch (err) {
    return null;
  }
};

// payment_method_types arrives as the literal string '["card"]'.
const toList = (raw) => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.join(', ') : String(raw);
  } catch (err) {
    return String(raw);
  }
};

// Stripe Checkout leaves the PaymentIntent description empty — the purchased
// product name only exists on the session's line items. Returns null on any
// failure so a missing key or a non-Checkout payment degrades quietly.
const checkoutSession = async (piId) => {
  const key = process.env.STRIPE_TEST_KEY;
  if (!key || !key.startsWith('sk_test_')) return null;

  const url = 'https://api.stripe.com/v1/checkout/sessions'
    + `?payment_intent=${encodeURIComponent(piId)}&limit=1&expand[]=data.line_items`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const payload = await res.json();
    return (payload.data && payload.data[0]) || null;
  } catch (err) {
    return null;
  }
};

exports.main = async (event, callback) => {
  const f = event.inputFields;
  const piId = f['pi_id'];

  if (!piId) {
    throw new Error('No PaymentIntent ID on the incoming event — cannot mirror the transaction.');
  }

  // This workflow is sandbox-only. A live event reaching it would file a real
  // payment as test data and double-count it against the Data Sync row.
  if (String(f['livemode']) === 'true') {
    return callback({ outputFields: { skipped: 'livemode' } });
  }

  const client = new hubspot.Client({
    accessToken: process.env.HUBSPOT_MIRROR_TOKEN
  });

  const properties = {
    test_txn_key:                  piId,
    record_environment:            'Test',
    stripe_payment_transaction_id: piId
  };

  if (f['currency'])             properties.currency             = f['currency'];
  if (f['status'])               properties.status               = f['status'];
  if (f['description'])          properties.description          = f['description'];
  if (f['capture_method'])       properties.capture_method       = f['capture_method'];
  if (f['confirmation_method'])  properties.confirmation_method  = f['confirmation_method'];
  if (f['payment_method'])       properties.payment_method       = f['payment_method'];
  if (f['statement_descriptor']) properties.statement_descriptor = f['statement_descriptor'];

  const methods = toList(f['payment_method_types']);
  if (methods) properties.allowed_payment_methods = methods;

  // Data Sync fills `customer_id` and leaves `customer` almost always empty -
  // populate both so the test rows match the shape Data Sync produces.
  if (f['customer_id']) {
    properties.customer    = f['customer_id'];
    properties.customer_id = f['customer_id'];
  }

  // The PaymentIntent has no name on it; billing_details inside the charge does.
  const charge = firstCharge(f['charges_json']);
  const billing = (charge && charge.billing_details) || {};

  if (billing.name)  properties.customer_name  = billing.name;
  if (billing.email) properties.customer_email = billing.email;

  const receiptEmail = f['receipt_email'] || billing.email;
  if (receiptEmail) properties.receipt_email = receiptEmail;

  // Anything still missing is recoverable from the Checkout session, which is
  // also the only place the product name lives.
  if (!properties.description || !properties.customer_name || !properties.customer_email) {
    const session = await checkoutSession(piId);
    const details = (session && session.customer_details) || {};
    const items = (session && session.line_items && session.line_items.data) || [];

    // Some product names already carry their price ("... Pay In Full - $1497"),
    // so only append the amount when the name does not.
    if (!properties.description && items.length) {
      properties.description = items
        .map((li) => {
          const name = li.description || '';
          if (name.includes('$')) return name;
          return `${name} ($${((li.amount_total || 0) / 100).toFixed(2)})`;
        })
        .join(' + ');
    }

    if (!properties.customer_name && details.name)   properties.customer_name  = details.name;
    if (!properties.customer_email && details.email) properties.customer_email = details.email;
    if (!properties.receipt_email && details.email)  properties.receipt_email  = details.email;
  }

  const amount = toAmount(f['amount']);
  if (amount !== undefined) properties.amount = amount;

  const amountReceived = toAmount(f['amount_received']);
  if (amountReceived !== undefined) properties.amount_received = amountReceived;

  const amountCapturable = toAmount(f['amount_capturable']);
  if (amountCapturable !== undefined) properties.amount_capturable = amountCapturable;

  const created = toTimestamp(f['created']);
  if (created) properties.created = created;

  // Upsert on test_txn_key so a redelivery updates the row instead of adding a
  // second one. Stripe retries failed events for up to three days.
  const res = await client.apiRequest({
    method: 'POST',
    path: `/crm/v3/objects/${OBJECT_TYPE}/batch/upsert`,
    body: {
      inputs: [{ idProperty: 'test_txn_key', id: piId, properties }]
    }
  });

  let recordId;
  try {
    const body = await res.json();
    recordId = body && body.results && body.results[0] && body.results[0].id;
  } catch (err) {
    // apiRequest already throws on non-2xx; a parse failure just means no id to report.
  }

  callback({
    outputFields: {
      recordId,
      piId,
      eventType: f['event_type'],
      description: properties.description || null,
      customerName: properties.customer_name || null
    }
  });
};
