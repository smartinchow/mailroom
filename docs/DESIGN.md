# Mailroom — Design Spec

Version 0.1 (design only, no code) — 17 August 2026

---

## 1. Problem

Transactional email is sent from several independent applications, across several sending
domains, through a cloud provider (ACS or SES). The provider gives delivery status but
**never retains message content** — ACS Event Grid payloads carry only
`sender`, `recipient`, `messageId`, `status`, `deliveryStatusDetails`, `deliveryAttemptTimeStamp`.
So "what exactly did we send that customer?" is unanswerable unless the sender records it.

Commercial products (Resend, Postmark) answer it but are third-party, offshore, and
per-domain. Existing open-source equivalents are SES-only. Nothing routes multiple domains
to multiple carriers from one deployment.

## 2. Goals

1. One HTTP API for all applications; a per-application API key.
2. Pluggable carriers. **ACS first**, SES second, SMTP third.
3. Complete message log — metadata *and* the rendered body — searchable, with the
   carrier's delivery events normalised onto each message.
4. Multi-domain: each sending domain routes to a chosen carrier.
5. Real rate limiting, so a low provider quota (ACS defaults to ~100/hour on a new
   resource) is configuration, not an outage.
6. Estate-wide suppression list — a hard bounce on one project protects every project.
7. Self-hosted, one `docker compose up`, small enough to read in an afternoon.

## 3. Non-goals

| Not doing | Why |
|---|---|
| MTA / Postfix / IP warming / DKIM signing | The carrier does this properly. Competing with it is a full-time job. |
| Inbound mail | ACS cannot receive. Out of scope entirely. |
| Campaigns, contact lists, segmentation | Listmonk already does this. |
| Template design UI | Applications own their HTML. Templates are a v2 maybe. |
| Multi-user RBAC | v1 is a single operator. |

## 4. Architecture

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

## 5. Data model (Postgres via Prisma)

**Project** — isolation unit; one per application, or per app-environment.
`id, name, slug (unique), bodyRetention, bodyRetentionDays, hourlyCap?, createdAt`

**ApiKey** — `id, projectId, name, prefix, keyHash, lastUsedAt, revokedAt, createdAt`
Plaintext shown once at creation. `keyHash` = SHA-256; compared in constant time.

**Carrier** — `id, type (ACS|SES|SMTP), name, configEnc, enabled, ratePerSecond, ratePerHour, createdAt`
`configEnc` is AES-256-GCM at rest, key-versioned (`<keyId>.<iv>.<tag>.<ct>`) so credentials
can be rotated without downtime.

**Domain** — `id, name (unique), projectId?, carrierId, fallbackCarrierId?, status
(PENDING|VERIFIED|FAILED|TEMPORARY_FAILURE), dnsRecords (DnsRecord[] json), mailFromDomain?,
verifiedAt?, lastCheckedAt?, verificationError?, notes, createdAt`
`projectId = null` means the domain is shared across projects. `status` gates sending
(D-07 extension, §9); carriers whose adapter implements `domains` (SES) provision and issue
`dnsRecords` to publish, others (ACS, SMTP) are "manual" and land `VERIFIED` at creation.

**Carrier** gains `isDefault` — exactly one carrier may be the default new domains
provision against; enforced in code, not the database.

**Message** — the log row.
`id (ULID), projectId, domainId, carrierId, idempotencyKey?, from, to[], cc[], bcc[],
replyTo?, subject, bodyHtml?, bodyText?, headers jsonb, tags jsonb, status,
providerMessageId?, attempts, lastError?, queuedAt, sentAt?, lastEventAt?,
redactedLinkCount, bodyPurgedAt?`
Indexes: `(projectId, queuedAt desc)`, `(providerMessageId)`, `(status, queuedAt)`,
unique `(projectId, idempotencyKey)`.

**MessageEvent** — append-only.
`id, messageId, type, recipient?, occurredAt, providerRaw jsonb, receivedAt`
Types: `QUEUED SENDING SENT DELIVERED BOUNCED SUPPRESSED COMPLAINED SPAM DELAYED FAILED OPENED CLICKED`

**Suppression** — `id, address (lowercased), scope (GLOBAL | domain name), reason
(HARD_BOUNCE|COMPLAINT|MANUAL), messageId?, createdAt, expiresAt?`
Unique `(address, scope)`.

**Attachment** — metadata only: `id, messageId, filename, contentType, bytes, sha256`.
Bytes are forwarded to the carrier and **never stored**.

### Status machine

```
QUEUED → SENDING → SENT → DELIVERED
                        ↘ BOUNCED | SUPPRESSED | SPAM | COMPLAINED
       ↘ FAILED (all send attempts exhausted, or suppressed pre-send)
```

`OPENED` / `CLICKED` are events, never statuses. Provider events arrive out of order and
can duplicate: apply an event only if `occurredAt` is newer than `lastEventAt`, and never
regress a terminal status. Ingest is idempotent on `(messageId, type, occurredAt)`.

## 6. HTTP API

Resend-shaped on purpose, so an existing `resend.emails.send({from,to,subject,html,replyTo})`
call site becomes a near-identical fetch.

### Send

```
POST /v1/emails
Authorization: Bearer mr_live_…
Idempotency-Key: <opaque, optional but recommended>

{ "from": "AMLify <noreply@amlify.au>", "to": ["a@b.com"], "subject": "…",
  "html": "…", "text": "…", "reply_to": "support@amlify.au",
  "cc": [], "bcc": [], "headers": {}, "tags": {"template":"invite"} }

→ 202 { "id": "01J…", "status": "queued" }
→ 200 { "id": "01J…", "status": "…" }   // idempotency-key replay, no second send
→ 403 { "error": "domain_not_allowed" } // from-domain not bound to this project
→ 409 { "error": "suppressed", "address": "…" }
```

`POST /v1/emails/batch` — array, max 100, per-item results.

### Read

```
GET /v1/emails/:id                → message + events (body per retention policy)
GET /v1/emails?status=&to=&domain=&template=&q=&after=&before=&cursor=&limit=
GET /v1/suppressions | POST | DELETE /v1/suppressions/:address
GET /health  → 200 {db, redis, carriers[]}
GET /metrics → Prometheus
```

### Hooks

```
POST /v1/hooks/acs/:endpointSecret
POST /v1/hooks/ses/:endpointSecret
```

### Admin (dashboard session, not API key)

Projects, carriers, domains, API keys, retention settings. CRUD only, no bulk export of
message bodies.

## 7. Carrier adapter contract

```ts
export interface Carrier {
  readonly type: "acs" | "ses" | "smtp";
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  /** Handshake + authenticity. Returns a body to echo, or a verdict. */
  verifyHook(raw: RawRequest): Promise<
    | { ok: true }
    | { ok: true; respondWith: unknown }   // e.g. Event Grid validationCode echo
    | { ok: false; reason: string }
  >;
  parseEvents(payload: unknown): NormalizedEvent[];
}
```

### ACS

- Send: `EmailClient.beginSend()`. The poller's operation id **is** the `messageId` that
  later appears in Event Grid — store it as `providerMessageId`.
- Hook: Event Grid delivers a **JSON array**, unsigned. Therefore:
  - handle `Microsoft.EventGrid.SubscriptionValidationEvent` by echoing
    `{ validationResponse: data.validationCode }`, else the subscription never activates;
  - authenticate on the URL `:endpointSecret` **and** by asserting `topic` equals the
    configured ACS resource id;
  - no raw-body requirement — mount after the JSON body parser.
- Status map: `Delivered→DELIVERED`, `Bounced→BOUNCED`, `Suppressed→SUPPRESSED`,
  `Quarantined→SPAM`, `FilteredSpam→SPAM`, `Failed→FAILED`, `Expanded→` (log only).
- `EmailEngagementTrackingReportReceived` → `OPENED` / `CLICKED` (`engagementContext` =
  clicked URL). Requires engagement tracking enabled on the ACS domain; off by default.
- Quota: new resources are capped low (~100/hour observed). Set `ratePerHour` to match and
  raise it after the Azure support quota increase, not in code.
- SMTP alternative: `smtp.azurecomm.net:587`, username
  `<acs-resource>.<entra-app-id>.<entra-tenant-id>`, password = an Entra app-registration
  client secret. Delivery reports still emit via Event Grid on this path.

### SES

- Send: `@aws-sdk/client-sesv2` `SendEmailCommand`; response `MessageId` →
  `providerMessageId`. Attach a **configuration set** with an event destination.
- Hook: SNS over HTTPS. Must handle `SubscriptionConfirmation` (GET the `SubscribeURL`)
  and **verify the SNS message signature** against the published certificate — SNS
  endpoints are otherwise trivially spoofable.
- Notification map: `Delivery→DELIVERED`, `Bounce`(Permanent)→`BOUNCED` + suppress,
  `Bounce`(Transient)→`DELAYED`, `Complaint→COMPLAINED` + suppress, `Reject→FAILED`,
  `Open→OPENED`, `Click→CLICKED`, `DeliveryDelay→DELAYED`.
- Region is per-carrier config. `ap-southeast-2` for Australian data residency.

### SMTP

nodemailer. No event stream — status stops at `SENT`, and the dashboard says so explicitly
rather than implying delivery. Used for Mailpit in development, and as an escape hatch.

## 8. Routing, retries, rate limits

- Routing: `from` domain → `Domain` row → `Carrier`. A `from` domain not bound to the
  calling project is **rejected**, not silently allowed — otherwise project A can send as
  project B's domain.
- Optional `fallbackCarrierId` per domain: after the primary returns 5xx on the final
  attempt, try the fallback once and record which carrier actually sent.
- Queue limiter per carrier (`ratePerSecond`, `ratePerHour`) plus an optional per-project
  `hourlyCap`. Several projects sharing one ACS resource share its quota; without the
  per-project cap one noisy project starves the rest.
- Retries: exponential backoff with jitter, max 5 attempts, retry only on 429/5xx/network.
  Exhausted → `FAILED` + event + `lastError`. Never silently drop.

## 9. Domain verification

Mailroom provisions and verifies sending domains itself, Resend-style, on top of whichever
carrier is marked default (§5) — the platform Amazon SES carrier out of the box. Mailroom
still never signs DKIM or touches DNS (D-03, D-14); it only asks the carrier to create the
identity and reports back the records a human must publish.

Flow:

1. **Create.** `POST /v1/domains { "name" }` resolves the project's default carrier, asks
   its `DomainProvisioner.createDomain()` for the identity, and stores the returned
   `DnsRecord[]` with `status = PENDING`. A carrier without a `domains` provisioner (ACS,
   SMTP) is "manual": the domain is marked `VERIFIED` immediately, no records issued —
   these carriers keep working exactly as before.
2. **Records.** Each record carries `type`, `name`, `value`, an optional `priority`/`ttl`,
   a `purpose` (`DKIM | MAIL_FROM_MX | MAIL_FROM_SPF | DMARC`), whether it's `required`,
   and its own per-record `status`. The dashboard renders these as a copyable table; DMARC
   is recommended, not required, to keep the happy path to "3 CNAMEs + 1 MX + 1 TXT".
3. **Poll.** A repeatable BullMQ job re-checks every `PENDING`/`TEMPORARY_FAILURE` domain
   on a provisioning carrier every 5 minutes via `checkDomain()`, sequentially per carrier
   to respect provider rate limits. `POST /v1/domains/:id/verify` runs the same check
   on demand. A domain stuck unverified for 72h flips to `FAILED`; re-running `verify`
   resets the window and restarts checking, matching Resend's UX.
4. **Gate.** `status !== VERIFIED` blocks sending from that domain (D-07 extension): the
   send route returns `403 domain_not_verified` before it ever reaches a carrier, so an
   unverified domain cannot leak a partially-configured send.
5. **Manual carriers.** ACS and SMTP domains carry no records and no polling — they are
   `VERIFIED` at creation and behave exactly as they did before this feature existed.

## 10. Content retention — security-critical

Stored HTML is not inert data. Application email routinely embeds **live credentials**:
magic links, onboarding-invite tokens, document-request tokens, reliance-share tokens.
A log that keeps raw bodies turns any read of that table — a leaked dashboard session, a
database dump, a careless support script — into account takeover on those links. It also
duplicates personal information outside the system of record, which matters for
Australian Privacy Act minimisation and for any retention commitment already made to
customers.

Design consequences, all defaults-on:

1. **Redaction at write time.** Before storing, rewrite every `href`: drop query
   parameters named `token`, `code`, `key`, `t`, `sig`, `secret`, and replace any path
   segment that looks high-entropy (≥20 chars, base64url/hex alphabet) with `[redacted]`.
   Visible link text is preserved. Count the substitutions into `redactedLinkCount` so the
   UI can show "3 links redacted" rather than pretending the body is verbatim.
2. **Per-project policy** `bodyRetention: none | redacted | full`, default `redacted`;
   `full` must be chosen deliberately, per project.
3. **Purge job.** Nightly, nulls `bodyHtml`/`bodyText` older than `bodyRetentionDays`
   (default 90) and stamps `bodyPurgedAt`. Metadata and events are kept.
4. **Rendering.** Bodies render only inside `<iframe sandbox>` with no `allow-scripts` and
   no `allow-same-origin`, under `Content-Security-Policy: default-src 'none'`. Remote
   images are click-to-load, so opening a log entry cannot phone home or fire a tracking
   pixel.
5. **Never log bodies.** Application logs carry `messageId` only. No body in error
   payloads, no body in metrics, no body in Sentry.
6. **No bulk body export** through the API or the dashboard. One message at a time.

## 11. Dashboard

Next.js, read-mostly.

- **Messages** — table: time, project, to, subject, template tag, carrier, status chip.
  Filters: project, domain, status, template, recipient, free-text, date range. Cursor
  paginated.
- **Message detail** — timeline of events with provider raw JSON collapsed, headers, and
  the sandboxed body preview with a redaction notice.
- **Suppressions** — list, reason, source message, manual add/remove.
- **Carriers** — health, last successful send, queue depth, quota headroom vs configured
  rate, recent failures.
- Auth: local account (password + TOTP) by default; optional OIDC (Entra, Google).
  Deliberately **not** GitHub-OAuth-only, which is useSend's most-complained-about
  constraint.

## 12. Client SDK

`@mailroom/client` — a ~60-line typed fetch wrapper, no dependencies.

```ts
const mail = createMailroom({ url: process.env.MAILROOM_URL!, apiKey: process.env.MAILROOM_KEY! });
await mail.send({ from, to, subject, html, replyTo, idempotencyKey, tags: { template: "invite" } });
```

Signature intentionally matches the shape existing callers already pass, so adopting
Mailroom is a transport swap with zero template changes.

## 13. Deployment

`docker compose` with `mailroom-api`, `mailroom-web`, `postgres:18-alpine`, `redis`.
Designed to sit on an existing box behind a shared reverse proxy on a shared network,
alongside other self-hosted services. Config via environment:

```
DATABASE_URL=            # Postgres
REDIS_URL=
MAILROOM_ENCRYPTION_KEY= # 64-char hex, AES-256-GCM for carrier configs
MAILROOM_ENCRYPTION_KEYS_OLD=  # optional, decrypt-only, during rotation
PUBLIC_URL=              # used to build hook URLs shown in the UI
SESSION_SECRET=
OIDC_ISSUER= OIDC_CLIENT_ID= OIDC_CLIENT_SECRET=   # optional
```

Carrier credentials live in the database (encrypted), not in env, so a new domain or a key
rotation is a UI action rather than a redeploy.

## 14. Observability

`/metrics`: `mailroom_messages_total{carrier,status}`,
`mailroom_send_duration_seconds{carrier}`, `mailroom_queue_depth{queue}`,
`mailroom_event_lag_seconds{carrier}`, `mailroom_suppressions_total{reason}`.
Structured JSON logs keyed by `messageId`. Optional Sentry DSN, `sendDefaultPii: false`.

## 15. Adopting it from an existing app

1. Deploy Mailroom, add the ACS carrier, add the domain, create a project + API key.
2. In the app, put the transport behind a flag: `MAIL_TRANSPORT=resend|mailroom`.
3. Shadow week: send via the incumbent, mirror to Mailroom, compare delivered/bounced
   counts before trusting it.
4. Flip the flag. Keep the old credentials for rollback for one more month.

## 16. Milestones

| # | Deliverable |
|---|---|
| M0 | Repo skeleton, Prisma schema, docker compose, `/health` |
| M1 | ACS carrier: send + Message log + Event Grid hook + status machine |
| M2 | Dashboard: message list, detail, sandboxed body preview |
| M3 | SES carrier + SNS hook (signature verification) |
| M4 | Suppression list, retention purge job, redactor + its tests |
| M5 | `@mailroom/client`, API keys UI, metrics |
| M6 | First real application cut over |

## 17. Open questions

1. **Licence** — AGPL-3.0 proposed (matches the peer set, discourages a hosted rip).
   Apache-2.0 if wider corporate adoption matters more. See `docs/decisions.md` D-08.
2. **Attachments in v1?** Metadata-only storage is specified; is forwarding needed at all
   for the first applications?
3. **Single image vs split api/web** — split is cleaner, single is one less container.
4. **Templates** — do applications keep owning HTML forever, or does v2 add stored
   templates with versioning?
