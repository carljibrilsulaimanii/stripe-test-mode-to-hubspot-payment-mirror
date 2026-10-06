<!--
  README.md -- Stripe test mode -> HubSpot payment mirror
  Author:  Jibril Sulaiman
  Date:    2026-10-06
  What:    Click-by-click guide for writing Stripe TEST-mode payments into the same
           HubSpot object that HubSpot's Stripe Data Sync fills with live payments,
           through a webhook-triggered workflow with one custom code action.
  Why:     Data Sync reads live Stripe data only, so every workflow that runs on
           payments (product names, routing, conversions) can only be tested by
           spending real money.
-->

# Stripe test mode → HubSpot payment mirror

Make Stripe **test-mode** payments show up in HubSpot, in the same object as your live
ones, so you can test payment workflows without real charges. A Stripe sandbox sends
`payment_intent.succeeded` to a HubSpot workflow; one custom code action writes the
payment into the payments object, marked **Record Environment = Test**, and keyed on
its own unique **Test Txn Key** so a retried event updates the row instead of adding a
second one.

It uses the webhook trigger set up in
[stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events).

## Why it exists

HubSpot's Stripe Data Sync copies Stripe payments into a HubSpot object, but **only
live ones**. A test card in a Stripe sandbox never reaches HubSpot. That leaves two bad
options for testing anything that runs on payments:

1. **Spend real money.** Buy your own product, then refund it: real fees, real refunds,
   real noise in revenue reports.
2. **Test on old records.** Re-enroll last week's payment, which never exercises the
   "a new payment just arrived" path that matters.

The mirror closes the gap: test payments land in the same object, with the same
property names and units as Data Sync's rows, so the workflows that read them run
unchanged. Two properties keep them apart from live data:

| Property | Live rows (Data Sync) | Test rows (this mirror) |
|---|---|---|
| **Record Environment** (`record_environment`) | empty, or `Live` | `Test` |
| **Test Txn Key** (`test_txn_key`) | empty | the PaymentIntent id |

Data Sync is set to **Do no matching**, so it never claims or overwrites the mirror's
rows; and the mirror skips any live event, so it never doubles a real payment.

## How it works

```text
 Stripe SANDBOX payment ──► event destination (payment_intent.succeeded)
                                   │
                                   ▼
 HubSpot workflow: "Webhook event is received" (unconnected event)
                                   │  18 inputs: data.object.id, amount, charges.data ...
                                   ▼
 Custom code ── livemode? ──► skip
            ── billing name/email from the charge in the payload
            ── description blank? ──► Stripe test key: Checkout Session line items
            ── batch upsert on test_txn_key, record_environment = Test
                                   ▼
            payments object row, same shape as a Data Sync row
```

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`workflow-action/`](workflow-action/) | The custom code action | Pasted into the workflow (Step 5) |
| [`test/`](test/) | Offline tests with HubSpot and Stripe faked | `npm test` |

## Table of contents

- [1. Requirements](#1-requirements)
- [2. Setup, step by step](#2-setup-step-by-step)
  - [Step 1: The payments object and two properties](#step-1-the-payments-object-and-two-properties)
  - [Step 2: A HubSpot service key and two secrets](#step-2-a-hubspot-service-key-and-two-secrets)
  - [Step 3: The webhook event](#step-3-the-webhook-event)
  - [Step 4: The Stripe sandbox event destination](#step-4-the-stripe-sandbox-event-destination)
  - [Step 5: The custom code action](#step-5-the-custom-code-action)
  - [Step 6: Test with a sandbox payment](#step-6-test-with-a-sandbox-payment)
  - [Step 7: Keep test rows out of reports](#step-7-keep-test-rows-out-of-reports)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)
- [Security](#security)
- [Related repos: Stripe beyond HubSpot Commerce](#related-repos-stripe-beyond-hubspot-commerce)

## 1. Requirements

| Need | Why |
|---|---|
| HubSpot's Stripe Data Sync, syncing payments into a custom object | The object test rows join |
| Workflows with custom code and the **Webhook event is received** trigger (Operations Hub / Data Hub Professional or above at the time of writing) | The mirror |
| A Stripe sandbox (or test mode) | Where test payments happen |

## 2. Setup, step by step

### Step 1: The payments object and two properties

About 5 minutes.

**1a.** Find the custom object Data Sync writes payments into (for example "Stripe
Payment Transactions"). Copy its type id (`2-12345678`) from the URL of its records
page, and paste it as `OBJECT_TYPE` at the top of
[`workflow-action/stripe-test-mirror-action.js`](workflow-action/stripe-test-mirror-action.js).

**1b.** Open the sync's settings (**Stripe Payment Transaction sync**: **Configure ·
Limit · Organize · Review**) and confirm **Sync direction** is Stripe → HubSpot and
**Record matching** is **Do no matching** (wording may differ). That's what keeps Data
Sync off the mirror's rows.

**1c.** Add two properties to the object in **Settings → Properties**:

| Label | Internal name | Field type |
|---|---|---|
| Test Txn Key | `test_txn_key` | Single-line text, with **unique values required** (wording may differ) |
| Record Environment | `record_environment` | Dropdown select: `Live`, `Test` |

> ⚠️ **Test Txn Key must be unique.** The action upserts on it, and HubSpot only allows
> an upsert on a property that requires unique values. It's also what makes a Stripe
> retry update the same row.

**1d.** The action also writes these, which a Data Sync object normally already has.
Add any that are missing: `stripe_payment_transaction_id`, `currency`, `status`,
`description`, `capture_method`, `confirmation_method`, `payment_method`,
`statement_descriptor`, `allowed_payment_methods`, `customer`, `customer_id`,
`customer_name`, `customer_email`, `receipt_email`, `amount`, `amount_received`,
`amount_capturable` (numbers) and `created` (date and time).

> ⚠️ **Match Data Sync's amount units.** Open a live row whose price you know: in
> production a $36.99 product read `36.99`, so Data Sync stores dollars and the action
> divides Stripe's cents by 100 (`AMOUNTS_IN_CENTS = false`). If yours reads `3699`, set
> it to `true`, or test rows land 100x off in any report.

✅ **Check:** both new properties exist, Test Txn Key requires unique values, and
`OBJECT_TYPE` is set.

### Step 2: A HubSpot service key and two secrets

About 5 minutes.

**2a.** In HubSpot's **Service Keys** page, click **Create service key**. On **Create
Service Key**, enter a **Name** (for example `Stripe Test Mirror`), then under
**Scopes** click **Add new scope** for `crm.objects.custom.read` and
`crm.objects.custom.write`, and click **Create**.

**2b.** In Stripe, switch to your **sandbox** and copy its secret key (`sk_test_...`).
It's used only to look up a Checkout Session when the payment's description is blank.

**2c.** Create two secrets, named exactly (or rename them at the top of the action):

| Secret | Value |
|---|---|
| `HUBSPOT_MIRROR_TOKEN` | The service key from 2a |
| `STRIPE_TEST_KEY` | The sandbox key from 2b |

> ⚠️ **A test key only.** The Checkout Session lookup refuses anything that isn't
> `sk_test_`. It degrades quietly instead of failing: the row is still written, just
> without a rebuilt description.

✅ **Check:** two secrets with those names.

### Step 3: The webhook event

About 10 minutes. Full detail, including the 50-property limit, is in
[stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events);
the choices for this mirror:

**3a.** Create a workflow from scratch. Trigger: **Webhook event is received** →
**Create new webhook event**. Name it, for example, `Stripe Sandbox → Payment
Transaction Mirror`, and **Copy** the URL under **Connect webhook**. Leave the dialog
open.

**3b.** Do Step 4 (the Stripe side), send one sandbox payment, and come back: the
dialog shows *"Event received at <date, time>"* with the payload (`type:
payment_intent.succeeded`, `livemode: false`, `api_version: 2017-08-15` on older
accounts). Click **Next: Event properties**.

**3c. Edit event properties.** Keep the ones the action reads and delete the rest
(Stripe's payload is over the 50-property limit):

| Keep | Type |
|---|---|
| `type` | String |
| `data.object.id` | String |
| `data.object.amount`, `.amount_received`, `.amount_capturable`, `.created` | Number |
| `data.object.currency`, `.status`, `.description`, `.receipt_email`, `.customer` | String |
| `data.object.capture_method`, `.confirmation_method`, `.payment_method`, `.payment_method_types`, `.statement_descriptor` | String |
| `data.object.charges.data` | String (it arrives as a JSON string on older API versions) |
| `data.object.livemode` | Boolean |

> ⚠️ **Delete `api_version`.** It's auto-typed **Date** (`2017-08-15`) and blocks **Next:
> Link to object** with *"Fix any property errors before continuing."*

**3d.** **Next: Link to object** → **No, keep this event unconnected to CRM records** →
**Create new event**. If it fails with *"Request for
https://app.hubspot.com/api/portal-event-ingest/v1/webhook-definitions failed with
status 400."*, you're still over 50 properties: delete more (the browser's DevTools →
Network → the failed request → Response shows `EVENT_PROPERTIES_LIMIT`).

✅ **Check:** the trigger reads **Webhook event is received** with your event.

### Step 4: The Stripe sandbox event destination

About 5 minutes.

**4a.** In Stripe, with the banner *"You are testing in a sandbox. No real transactions
will be processed."* showing, open **Workbench → Webhooks → Create an event
destination**.

**4b.** **Select events:** scope **Your account**; under **Events**, find and tick
`payment_intent.succeeded`. **Continue**.

**4c.** **Choose destination type:** **Webhook endpoint**. **Continue**.

**4d.** **Configure your destination:** paste the HubSpot URL from 3a, name it, create
it.

> ⚠️ **Sandbox only.** Never point a live-mode destination at this workflow. The action
> skips live events (`skipped: livemode`), but a live destination would still run the
> workflow on every real sale.

✅ **Check:** the sandbox destination is **Active** and listening to 1 event.

### Step 5: The custom code action

About 10 minutes.

**5a.** Add a **Custom code** action after the trigger. **Language:** Node.js 20.x.
**Secrets:** `HUBSPOT_MIRROR_TOKEN` and `STRIPE_TEST_KEY`.

**5b. Property to include in code**, one row each. Pick each value from **Trigger
data → your event (trigger)**:

| Input name | Value |
|---|---|
| `pi_id` | `data.object.id` |
| `amount` | `data.object.amount` |
| `amount_received` | `data.object.amount_received` |
| `amount_capturable` | `data.object.amount_capturable` |
| `currency` | `data.object.currency` |
| `status` | `data.object.status` |
| `created` | `data.object.created` |
| `description` | `data.object.description` |
| `receipt_email` | `data.object.receipt_email` |
| `customer_id` | `data.object.customer` |
| `capture_method` | `data.object.capture_method` |
| `confirmation_method` | `data.object.confirmation_method` |
| `payment_method` | `data.object.payment_method` |
| `payment_method_types` | `data.object.payment_method_types` |
| `statement_descriptor` | `data.object.statement_descriptor` |
| `charges_json` | `data.object.charges.data` |
| `livemode` | `data.object.livemode` |
| `event_type` | `type` |

Delete any empty row, or saving fails with *"Property selection is required"*.

**5c.** Delete the sample code and paste in **all** of
[`workflow-action/stripe-test-mirror-action.js`](workflow-action/stripe-test-mirror-action.js).

**5d. Data outputs** (optional, for run history): `recordId`, `piId`, `eventType`,
`description`, `customerName`, all **String**.

**5e.** Publish the workflow.

✅ **Check:** the workflow is published with two steps: the trigger and **Custom code**.

### Step 6: Test with a sandbox payment

About 5 minutes.

**6a.** Pay one of your sandbox Payment Links with a Stripe test card (or run
`stripe trigger payment_intent.succeeded` in the Stripe CLI or Shell while in the
sandbox).

**6b.** Open the workflow's **Run History**. The trigger reads **Webhook event is
received**, and **Custom code** shows **Done** with *"Successfully executed"*, outputs
`recordId`, `piId` and `eventType` (`payment_intent.succeeded`), *"This action's final
success or failure state"* **Succeeded**, and **Function logs** with memory and runtime.

**6c.** Open the payments object: a new row whose **Record Environment** is **Test**
and **Test Txn Key** is the `pi_...` id, with the amount in the same units as live rows.

**6d. Resend to prove it updates.** In Stripe, open the event (Workbench → **Events**,
or **Inspector** with the `pi_...` id), find its delivery to your endpoint and resend it
(wording may differ). The same row updates; no second row appears.

✅ **Check:** one sandbox payment, one Test row; resending changes nothing but the
row's last-modified time.

### Step 7: Keep test rows out of reports

About 5 minutes.

Add **Record Environment is not Test** to every report, dashboard filter and list built
on the payments object, and to the enrollment of any workflow that should only act on
real money (for example a Conversions API sender). Workflows you're testing should
include test rows on purpose.

✅ **Check:** your revenue report shows the same total before and after a test payment.

## Troubleshooting

| You got | Cause | Fix |
|---|---|---|
| *"Fix any property errors before continuing."* | `api_version` typed as Date | Delete it (Step 3c) |
| *"...webhook-definitions failed with status 400."* | Over 50 properties | Delete more (Step 3d) |
| `No PaymentIntent ID on the incoming event` | `pi_id` not mapped to `data.object.id` | Step 5b |
| `skipped: livemode` | A live event reached the workflow | Point only the sandbox destination at it (Step 4) |
| Upsert fails on `test_txn_key` | Property not set to unique | Step 1c |
| Test amounts 100x off | Units don't match Data Sync | `AMOUNTS_IN_CENTS` (Step 1d) |
| Description blank on test rows | `STRIPE_TEST_KEY` missing or not `sk_test_`, or not a Checkout payment | Step 2b |
| Two rows for one payment | Upsert key differs between runs | Check `test_txn_key` is the `pi_` id (Step 5b) |
| Test rows in revenue reports | Missing filter | Step 7 |

## Limits

- **One event type.** `payment_intent.succeeded` only; refunds and failed payments
  aren't mirrored.
- **Test rows aren't associated to contacts** by this action; add your usual
  association step if a workflow under test needs one.
- **Older API versions only for billing details.** On `2017-08-15` the charge arrives
  inside the PaymentIntent payload; on newer versions it doesn't, so names and emails
  come from the Checkout Session lookup instead.

## Security

- **Sandbox key only** in `STRIPE_TEST_KEY`; the code refuses anything else.
- **Service key with two scopes**, used by this action alone.
- **The webhook URL takes posts from anyone.** The worst a forged post can do here is
  write a fake Test row, which reports exclude (Step 7). Don't reuse this workflow for
  live data.

## Related repos: Stripe beyond HubSpot Commerce

This repo is one of a set of guides for taking Stripe payments without HubSpot
Commerce, and for getting the Stripe data that HubSpot's native Stripe
integration leaves out into HubSpot. Each one stands alone.

| Repo | What it adds |
|---|---|
| [hubspot-order-form-stripe-checkout-link-integration](https://github.com/carljibrilsulaimanii/hubspot-order-form-stripe-checkout-link-integration) | A HubSpot order form that hands buyers to a Stripe Payment Link, and writes the UTMs back onto the payment record |
| [stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events) | Any Stripe event into a HubSpot workflow through the "Webhook event is received" trigger, no middleware |
| [hubspot-capi-server-side-lead-and-purchase-conversions-meta-google](https://github.com/carljibrilsulaimanii/hubspot-capi-server-side-lead-and-purchase-conversions-meta-google) | Stripe purchases sent server-side from HubSpot workflows to Meta and Google |
| [hubspot-stripe-zero-dollar-checkout-sync](https://github.com/carljibrilsulaimanii/hubspot-stripe-zero-dollar-checkout-sync) | Free and 100%-off Stripe Checkout orders, which create no payment, written into a HubSpot custom object, plus a backfill |
| [hubspot-stripe-payment-product-names-and-routing](https://github.com/carljibrilsulaimanii/hubspot-stripe-payment-product-names-and-routing) | Which product each Stripe payment was for, written onto the payment record, and a master workflow that routes buyers by product |
| **stripe-test-mode-to-hubspot-payment-mirror** (this repo) | Stripe test-mode payments in the same HubSpot object as live ones, so payment workflows can be tested without real charges |

---

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
