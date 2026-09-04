# Mailroom

Self-hosted transactional email service fronting a cloud carrier (ACS / SES / SMTP).
Read `docs/DESIGN.md` before proposing anything, and `docs/decisions.md` before re-opening
a settled question.

## Core stance

Mailroom is **not an MTA**. No Postfix, no DKIM signing, no IP warming, no reputation
management — the carrier does all of it. Mailroom owns the send API, the queue, the
normalised event log, the suppression list, and the dashboard. Any proposal that drifts
toward delivering mail directly is out of scope (D-03).

## Facts that are easy to get wrong

- **ACS Event Grid payloads contain no subject and no body** — only `sender`, `recipient`,
  `messageId`, `status`, `deliveryStatusDetails`, `deliveryAttemptTimeStamp`. Content exists
  only because Mailroom records it at send time. ACS retains nothing.
- **ACS status values**: `Delivered` `Suppressed` `Bounced` `Quarantined` `FilteredSpam`
  `Expanded` `Failed`. Engagement (`View`/`Click`) is a separate event type and is off
  unless enabled on the domain.
- **Event Grid is unsigned** and delivers a JSON **array**. Authenticate via the URL secret
  plus a `topic` check, and echo `data.validationCode` for
  `Microsoft.EventGrid.SubscriptionValidationEvent` or the subscription never activates.
- **SNS must have its signature verified** against the published certificate, and its
  `SubscriptionConfirmation` handled. An unverified SNS endpoint accepts forged events.
- **On AWS, SES sends and SNS only reports.** SNS is not a sending provider (D-09).
- **The ACS `messageId`** that appears in Event Grid is the `beginSend` operation id — store
  it as `providerMessageId` at send time or events can never be matched.
- **ACS quota** on a new resource is low (~100/hour) and is raised by support ticket. It
  lives in carrier config (`ratePerHour`), never hardcoded.
- **ACS SMTP relay**: `smtp.azurecomm.net:587`, username
  `<acs-resource>.<entra-app-id>.<entra-tenant-id>`, password = Entra app client secret.
  Event Grid reports still fire on this path.
- **SES sandbox** caps a new account at 200 emails/24h, 1/sec, verified-recipients-only,
  until AWS approves production access. Check via the admin carrier quota endpoint.
- **SNS posts `Content-Type: text/plain`**, not JSON — Fastify hands the hook route a
  string; parse it explicitly.
- **SES identities are region-bound**; the custom MAIL FROM subdomain is always
  `send.<domain>` so SPF aligns with the From domain.
- **`Domain.status` must be `VERIFIED` to send** (D-07 extension) — ACS/SMTP domains are
  "manual" and land `VERIFIED` at creation; only SES provisions and polls.
- **Exactly one `Carrier.isDefault`** — new domains provision against it; enforce in code.

## Non-negotiables

- **Bodies are redacted by default** (D-06). Stored HTML contains live magic-link and
  invite tokens. Never add a bulk body export, never log a body, never render one outside a
  `sandbox`ed iframe without `allow-scripts`/`allow-same-origin`.
- **A key may only send from its project's domains** (D-07). Enforce at send time.
- **Event ingest is idempotent and never regresses a terminal status.** Provider events
  duplicate and arrive out of order.
- **Sends never silently drop.** Retry exhaustion writes `FAILED` plus an event plus
  `lastError`.
- **Carrier credentials are encrypted at rest** and key-versioned so rotation needs no
  redeploy.

## Conventions (once code exists)

- TypeScript throughout. Postgres via Prisma. BullMQ + Redis for the queue.
- Every carrier implements the same `Carrier` interface — `send`, `verifyHook`,
  `parseEvents`. No provider-specific branches outside `carriers/`.
- Tests live beside the module in `__tests__/`. The redactor and each `parseEvents` mapping
  are the highest-value tests in the codebase — write them first.
