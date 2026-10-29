# External integration contracts

## Notifications

The existing outbox supports in-app, email/SMS interfaces and optional WhatsApp through an approved HTTPS bridge. An absent provider gives BLOCKED, never SENT. The bridge receives `{channel,to,subject,body,idempotencyKey}` with a Bearer token and `Idempotency-Key` header. It must honor that key across retries and return a nonempty `{id}` only after accepting the real message. ERP SENT records provider acknowledgement, not handset delivery/read confirmation; delivery receipts are not implemented.

Linked recipients require enabled channel preferences and recorded consent; email must match that user's email. Consent is rechecked before dispatch. An unlinked external recipient requires explicit consent evidence, retained in the audit event. Establish approved consent verification and retention rules; do not invent consent. Templates are channel-specific, active and use `{{variable_name}}`; API requests can supply a string `variables` object. The UI does not yet have a variable editor. Provider errors are redacted. Deterministic test doubles are not real delivery.

## Payment bridge and webhook

`PaymentGateway` is a typed boundary for an approved bridge, not a fabricated gateway implementation. The bridge's intent endpoint receives `{id,amountMinor,currency,idempotencyKey}` and returns `{reference,checkoutUrl}` over HTTPS. No raw card information is collected or stored. Network/unknown intent outcomes become exception states requiring reconciliation before retry.

The provider posts exact JSON bytes as **application/octet-stream** to `/api/integrations/payments/webhook`. Headers:

- `x-payment-timestamp`: integer Unix seconds, within five minutes.
- `x-payment-signature`: hex HMAC-SHA256 of `timestamp + '.' + raw_body`, using `PAYMENT_WEBHOOK_SECRET`.

Body: `{eventId,intentId,reference,amountMinor,currency,state}`. State is `captured` or `failed`. The bridge must generate these events only from verified provider facts. Changed bytes, stale signatures and reused event identities with different bytes are rejected. A correctly signed amount/currency/reference mismatch is retained as an exception. Repeated identical event delivery creates no duplicate event or receipt.

A verified capture is external evidence only. Finance must reconcile it to a recorded ERP payment with the same student and amount; that payment must already have valid fee allocations. The event does not silently create or change receipts, charges or balances. Real capture/refund, payout settlement and provider sandbox verification remain blocked/unimplemented as documented.

## SSO

`IdentityProvider` defines authorization/exchange boundaries. `/api/auth/sso/status` exposes only setup status/missing variable names. No endpoint trusts unsigned user claims or bypasses password/MFA authentication. A selected IdP adapter must verify issuer/audience/signatures, state, nonce, PKCE, replay resistance and an approved account-linking policy before login is enabled.
