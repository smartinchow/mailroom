# Mailroom

Self-hosted transactional email service. Your mailroom, your carriers, your logs.

One deployment fronts many applications and many sending domains. Applications call a
Resend-shaped HTTP API; Mailroom queues, rate-limits, sends via a pluggable **carrier**
(Azure Communication Services, Amazon SES, or plain SMTP), ingests the carrier's delivery
events, and keeps a searchable log — including the rendered message body, redacted of
live tokens by default.

Mailroom is deliberately **not an MTA**. It does not run Postfix, warm IPs, sign DKIM, or
manage sending reputation — the carrier does all of that properly. Mailroom is the thin
layer the carriers don't give you: a send API, a queue with real rate limits, a normalised
event log, an estate-wide suppression list, and a dashboard where you can actually see
what was sent.

## Why

Cloud carriers give you delivery status but **never retain message content** — an ACS
Event Grid payload carries only sender, recipient, message id, and status. So "what
exactly did we send that customer?" is unanswerable unless the sender records it.

Every existing open-source "self-hosted Resend" is locked to Amazon SES
([useSend](https://github.com/usesend/usesend), [FreeResend](https://www.freeresend.com/),
[Plunk](https://github.com/useplunk/plunk), [sesdashboard](https://github.com/Nikeev/sesdashboard)),
or it is its own MTA ([Postal](https://github.com/postalserver/postal),
[Cuttlefish](https://github.com/mlandauer/cuttlefish)). Nothing supports Azure
Communication Services, and nothing lets one deployment route different domains to
different carriers.

## Features

- **One HTTP API for all applications** — Resend-shaped on purpose, so an existing
  `resend.emails.send({...})` call site becomes a near-identical fetch. Per-application
  API keys with project isolation.
- **Pluggable carriers** — ACS, SES, and SMTP behind one adapter interface. Each sending
  domain routes to a chosen carrier, with an optional fallback carrier.
- **Complete message log** — metadata *and* the rendered body, searchable, with the
  carrier's delivery events normalised onto each message
  (`QUEUED → SENDING → SENT → DELIVERED / BOUNCED / SUPPRESSED / SPAM / FAILED`).
- **Real rate limiting** — per-carrier and per-project limits in the queue, so a low
  provider quota (ACS starts at ~100/hour) is configuration, not an outage.
- **Estate-wide suppression list** — a hard bounce or complaint on one project protects
  every project.
- **Idempotent sends** — `Idempotency-Key` replays return the original message instead of
  sending twice. Retries never silently drop: exhausted sends are marked `FAILED` with an
  event and the last error.
- **Body redaction by default** — magic-link and invite tokens are stripped from stored
  HTML at write time (see [Security](#security)).
- **Self-hosted, small** — four containers, one `docker compose up`, readable in an
  afternoon.

## What it is not

- Not a marketing/campaign tool — that's Listmonk's job.
- Not an inbound mail server. ACS cannot receive mail at all.
- Not a template designer. Applications own their HTML.

## Architecture

```
  app ──POST /v1/emails (Bearer mr_live_…)──▶  API (Node + TS)
                                               │  validate → resolve domain → carrier
                                               │  suppression check
                                               │  INSERT Message (QUEUED)
                                               ▼
                                          BullMQ send queue (Redis)
                                               │  limiter: per carrier + per project
                                               ▼
                                          Carrier adapter
                                          ├─ acs   @azure/communication-email
                                          ├─ ses   @aws-sdk/client-sesv2
                                          └─ smtp  nodemailer
                                               │  → providerMessageId
                                               ▼
                                          Message = SENT
  Event Grid ─┐
  SNS       ──┴─▶ POST /v1/hooks/{acs|ses}/:endpointSecret
                     → normalise → INSERT MessageEvent → advance Message.status

  Dashboard (Next.js) ──▶ read API ──▶ log list, filters, body preview
```

Services: `mailroom-api`, `mailroom-web`, `postgres`, `redis`. Four containers.

## Quickstart

```sh
git clone https://github.com/your-org/mailroom.git
cd mailroom
cp .env.example .env    # set MAILROOM_ENCRYPTION_KEY (64-char hex), SESSION_SECRET, PUBLIC_URL
docker compose up -d
```

Open the dashboard, then:

1. Add a **carrier** (ACS, SES, or SMTP) with its credentials — they are encrypted at
   rest, not stored in env.
2. Add your **sending domain** and bind it to the carrier.
3. Create a **project** and an **API key**. The key is shown once.

### Add and verify your domain

If your carrier provisions domains (the platform SES carrier does; ACS/SMTP carriers are
"manual" and skip straight to verified), add the domain through the API and publish the
records it hands back before your first send:

```sh
curl -X POST "$MAILROOM_URL/v1/domains" \
  -H "Authorization: Bearer mr_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "acme.example" }'
# → 201 { "id": "…", "name": "acme.example", "status": "pending", "records": [ … ] }
```

Each returned record has a `type` (`CNAME|MX|TXT`), `name`, `value`, `purpose`
(`dkim|mail_from_mx|mail_from_spf|dmarc`), and `required` — publish every `required: true`
record at your DNS provider (Cloudflare users: leave the DKIM CNAMEs **DNS only**, not
proxied). Mailroom re-checks every 5 minutes on its own, or check on demand:

```sh
curl -X POST "$MAILROOM_URL/v1/domains/<id>/verify" -H "Authorization: Bearer mr_live_..."
# → 200 { "status": "verified", … }
```

Sending from a domain that hasn't reached `verified` is rejected with `403
domain_not_verified` — see [Domain verification](docs/DESIGN.md#9-domain-verification).

Send with curl:

```sh
curl -X POST "$MAILROOM_URL/v1/emails" \
  -H "Authorization: Bearer mr_live_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: welcome-user-42" \
  -d '{
    "from": "Acme <noreply@acme.example>",
    "to": ["someone@example.com"],
    "subject": "Welcome",
    "html": "<p>Hello!</p>",
    "tags": { "template": "welcome" }
  }'
# → 202 { "id": "01J…", "status": "queued" }
```

Or with the SDK (`pnpm add @mailroom/client` — zero runtime dependencies, ESM,
Node ≥ 18):

```ts
import { createMailroom } from "@mailroom/client";

const mail = createMailroom({
  url: process.env.MAILROOM_URL!,
  apiKey: process.env.MAILROOM_KEY!,
});

const { id, status } = await mail.send({
  from: "Acme <noreply@acme.example>",
  to: "someone@example.com",          // string or string[]
  subject: "Welcome",
  html: "<p>Hello!</p>",
  replyTo: "support@acme.example",
  tags: { template: "welcome" },
  idempotencyKey: "welcome-user-42",
});

const detail = await mail.get(id);                       // message + events
const page = await mail.list({ status: "bounced" });     // cursor-paginated search
```

Non-2xx responses throw a `MailroomError` carrying `status` and the parsed error body.

## API reference (summary)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/emails` | API key | Queue one email. `Idempotency-Key` header supported. → `202 { id, status }` |
| `POST /v1/emails/batch` | API key | Queue up to 100 emails; per-item results. |
| `GET /v1/emails/:id` | API key | Message + normalised events (body per retention policy). |
| `GET /v1/emails` | API key | Search: `status, to, domain, template, q, after, before, cursor, limit`. |
| `GET /v1/suppressions` | API key | List suppressions. |
| `POST /v1/suppressions` | API key | Add a suppression. |
| `DELETE /v1/suppressions/:address` | API key | Remove a suppression. |
| `POST /v1/domains` | API key | Add a sending domain on the project's default carrier. → `201` domain + DNS records. |
| `GET /v1/domains` | API key | List the project's domains. |
| `GET /v1/domains/:id` | API key | Fetch one domain, its records, and verification status. |
| `POST /v1/domains/:id/verify` | API key | Re-check verification now (also restarts an expired 72h window). |
| `DELETE /v1/domains/:id` | API key | Remove a domain. `409 domain_in_use` if messages reference it. |
| `POST /v1/hooks/acs/:endpointSecret` | URL secret + topic check | ACS Event Grid delivery/engagement events. |
| `POST /v1/hooks/ses/:endpointSecret` | URL secret + SNS signature | SES event notifications via SNS. |
| `GET /health` | — | `{ db, redis, carriers[] }` |
| `GET /metrics` | — | Prometheus metrics. |

Notable errors: `403 domain_not_allowed` (the `from` domain is not bound to the calling
project), `409 suppressed` (recipient is on the suppression list).

## Carrier setup notes

### Azure Communication Services (ACS)

- Create an Event Grid subscription on the ACS resource pointing at
  `https://<your-host>/v1/hooks/acs/<endpointSecret>` (the dashboard shows the exact URL).
  Mailroom answers the Event Grid subscription-validation handshake automatically, and
  authenticates events by the URL secret plus a check that the event `topic` matches your
  ACS resource — Event Grid deliveries are unsigned.
- **Quota:** a new ACS resource is capped low (~100 emails/hour). Set the carrier's
  `ratePerHour` to match, and raise it only after Azure support grants a quota increase —
  the limit is configuration, never code.
- Open/click events require engagement tracking to be enabled on the ACS domain (off by
  default).
- An SMTP relay path (`smtp.azurecomm.net:587`, Entra app credentials) also exists;
  Event Grid delivery reports still fire on that path.

### Amazon SES

- **IAM.** A dedicated IAM user (e.g. `mailroom-ses`) with an inline policy scoped to
  sending — `ses:SendEmail`, `ses:SendRawEmail` — plus identity management so Mailroom can
  provision domains on your behalf: `CreateEmailIdentity`, `DeleteEmailIdentity`,
  `GetEmailIdentity`, `ListEmailIdentities`, `PutEmailIdentityMailFromAttributes`,
  `PutEmailIdentityDkimAttributes`, `PutEmailIdentityDkimSigningAttributes`,
  `PutEmailIdentityConfigurationSetAttributes`, `PutEmailIdentityFeedbackAttributes`,
  `TagResource`, `GetAccount`, `GetConfigurationSet`. No key values belong in this repo or
  its docs — generate and store them as a Mailroom carrier config (encrypted at rest).
- **Configuration set + events.** Sends use SES v2 with a configuration set (reputation
  metrics on) whose event destination publishes `BOUNCE, COMPLAINT, DELIVERY, REJECT,
  DELIVERY_DELAY, RENDERING_FAILURE` to an SNS topic; subscribe that topic (HTTPS) to
  `https://<your-host>/v1/hooks/ses/<endpointSecret>`. Mailroom confirms the SNS
  subscription automatically (fetches `SubscribeURL`) and **verifies every SNS message
  signature** against the published certificate — an unverified SNS endpoint would accept
  forged bounce/complaint events. Note SNS posts with `Content-Type: text/plain`, not JSON.
- **Sandbox limits.** A new SES account starts in the sandbox: 200 emails/24h, 1/sec, and
  every recipient must itself be a verified identity, until AWS approves a production
  access request. Check current quota via the admin carrier quota endpoint
  (`GetAccount`) rather than assuming it's been lifted.
- **Domain provisioning.** Mailroom requests Easy DKIM (3 CNAMEs to `*.dkim.amazonses.com`)
  and a custom MAIL FROM subdomain `send.<domain>` (MX `feedback-smtp.<region
  >.amazonses.com` priority 10, TXT `v=spf1 include:amazonses.com ~all`) plus a recommended
  DMARC TXT — see [Add and verify your domain](#add-and-verify-your-domain). SES identities
  are **region-bound**: a domain verified in `ap-southeast-2` is not verified in another
  region. Cloudflare users must leave the DKIM CNAMEs un-proxied (DNS only). The
  verification window is 72h; re-run `verify` to restart it.
- Permanent bounces and complaints are auto-added to the suppression list. Region is
  per-carrier config (e.g. `ap-southeast-2` for Australian data residency).
- On AWS, SES sends and SNS only reports — SNS is not a sending provider.

### SMTP

- Plain SMTP via nodemailer — useful for Mailpit in development and as an escape hatch.
- **No delivery events.** Status stops at `SENT`, and the dashboard says so explicitly
  rather than implying delivery.

## Security

- **Bodies are redacted by default.** Transactional email routinely embeds live
  credentials — magic links, invite tokens, document-request tokens. Before a body is
  stored, every link is rewritten: token-like query parameters are dropped and
  high-entropy path segments replaced with `[redacted]`, with a per-message count so the
  UI shows "N links redacted". Retention is per-project (`none | redacted | full`,
  default `redacted`) and a nightly job purges bodies past the retention window
  (default 90 days).
- **Sandboxed rendering.** Bodies render only inside an `<iframe sandbox>` without
  `allow-scripts` or `allow-same-origin`, under `Content-Security-Policy: default-src
  'none'`; remote images are click-to-load. Opening a log entry cannot execute scripts or
  fire tracking pixels.
- **No bulk body export** via API or dashboard, and bodies never appear in application
  logs, metrics, or error reports.
- **Encrypted carrier credentials.** Carrier configs are AES-256-GCM encrypted at rest
  and key-versioned, so credential and encryption-key rotation need no redeploy.
- **Project isolation.** An API key can only send from domains bound to its project —
  enforced at send time, so one application can never send as another's domain.
- **Hook authenticity.** SNS signatures are verified; Event Grid events are checked
  against the URL secret and the configured topic. Event ingest is idempotent and never
  regresses a terminal status.

## Repository layout

```
apps/api          # Fastify API, queue workers, carrier adapters, hooks
packages/client   # @mailroom/client — zero-dependency typed SDK
docs/DESIGN.md    # the design spec — start here
docs/decisions.md # settled questions (read before re-opening one)
```

## License

[AGPL-3.0-only](LICENSE). Internal use is unaffected; if you modify Mailroom and offer it
over a network, you must share your changes.
