# Spec — Mailroom-managed sending domains (Resend model on Amazon SES)

Status: approved for implementation 2026-09-04. Owner: Mailroom.

## Goal

Any project can add its own sending domain to Mailroom, receive the DNS records it must
publish, and have Mailroom verify the domain against the carrier — exactly the flow
resend.com offers. One platform-level Amazon SES carrier (`ses-mailroom`,
account 541165757072, region `ap-southeast-2`, configuration set `mailroom`) is the
default carrier for every new domain. ACS and SMTP carriers keep working unchanged.

Non-goals: Mailroom never signs DKIM or touches DNS itself (D-03). No automatic DNS
publishing to registrars in this iteration.

## Terminology

- **Provisioning carrier** — a carrier whose adapter implements `domains` (below). SES is
  the first. ACS/SMTP do not provision; domains on them are "manual".
- **MAIL FROM domain** — the SES custom MAIL FROM subdomain, always `send.<domain>`
  (Resend uses the same name). Required so SPF aligns with the From domain.

## 1. Data model (Prisma, new migration `20260904_domains_verification`)

```prisma
enum DomainStatus {
  PENDING      // records issued, waiting for DNS + provider check
  VERIFIED     // provider reports DKIM verified (and MAIL FROM ok) OR manual carrier
  FAILED       // provider reported FAILED, or 72h window expired
  TEMPORARY_FAILURE // provider transient state; poller keeps trying
}

model Domain {
  // existing fields unchanged: id, name (unique), projectId?, carrierId,
  // fallbackCarrierId?, verifiedAt?, notes?
  status          DomainStatus @default(PENDING)
  dnsRecords      Json         @default("[]")   // DnsRecord[] (below)
  mailFromDomain  String?                        // "send.<name>" for SES
  lastCheckedAt   DateTime?
  verificationError String?
  createdAt       DateTime     @default(now())
}

model Carrier {
  // existing fields unchanged
  isDefault Boolean @default(false)   // exactly one carrier may be default; enforce in code
}
```

Migration data fix-ups (SQL in the migration, not a script):
- All existing `Domain` rows → `status = 'VERIFIED'`, `verifiedAt = COALESCE(verifiedAt, now())`.
  They are live production senders (tx.amlify.au, tintinpos.com, maro.com.au).
- No carrier is default after migration; set via admin API (ops step, see §8).

`DnsRecord` JSON shape (stored and returned verbatim):

```ts
interface DnsRecord {
  type: "CNAME" | "MX" | "TXT";
  name: string;        // fully-qualified, no trailing dot, e.g. "abc._domainkey.example.com"
  value: string;       // e.g. "abc.dkim.amazonses.com" | "feedback-smtp.ap-southeast-2.amazonses.com"
  priority?: number;   // MX only (10)
  ttl?: number;        // suggested, e.g. 300 (informational)
  purpose: "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC";
  required: boolean;   // DMARC is recommended, not required
  status: "PENDING" | "VERIFIED" | "FAILED" | "NOT_STARTED";
}
```

## 2. Carrier contract extension (`apps/api/src/carriers/types.ts`)

```ts
export interface DomainProvisioner {
  /** Register the identity with the provider. Idempotent: if it already exists, return its records. */
  createDomain(name: string, opts: { mailFromDomain: string }): Promise<{ records: DnsRecord[] }>;
  /** Ask the provider for the current verification state and per-record status. */
  checkDomain(name: string, opts: { mailFromDomain: string }): Promise<{
    status: DomainStatus;
    records: DnsRecord[];     // same records as createDomain, with fresh status
    error?: string;
  }>;
  /** Remove the identity. Must not throw if it is already gone. */
  deleteDomain(name: string): Promise<void>;
}

export interface Carrier {
  // existing: type, send, verifyHook, parseEvents
  domains?: DomainProvisioner;
}
```

### SES implementation (`apps/api/src/carriers/ses.ts`)

- `createSesCarrier(config, deps?)` gains an optional second argument
  `{ client?: SESv2Client }` so tests inject a fake client (no new mocking library).
  Default behaviour unchanged.
- `createDomain`:
  1. `CreateEmailIdentityCommand({ EmailIdentity: name, ConfigurationSetName: config.configurationSet,
     DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" } })`.
     On `AlreadyExistsException` fall through to `GetEmailIdentityCommand` to read tokens.
  2. `PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: name, MailFromDomain: opts.mailFromDomain,
     BehaviorOnMxFailure: "USE_DEFAULT_VALUE" })`.
  3. Build records: 3 × CNAME `<token>._domainkey.<name>` → `<token>.dkim.amazonses.com`
     (purpose DKIM, required); MX `send.<name>` → `feedback-smtp.<region>.amazonses.com`
     priority 10 (MAIL_FROM_MX, required); TXT `send.<name>` → `v=spf1 include:amazonses.com ~all`
     (MAIL_FROM_SPF, required); TXT `_dmarc.<name>` → `v=DMARC1; p=none;` (DMARC, required=false).
     All statuses `PENDING` on creation.
- `checkDomain`: `GetEmailIdentityCommand`. Map:
  - `DkimAttributes.Status` → DKIM records: `SUCCESS`→VERIFIED, `FAILED`→FAILED,
    `TEMPORARY_FAILURE`→PENDING (domain status TEMPORARY_FAILURE), `PENDING`/`NOT_STARTED`→PENDING.
  - `MailFromAttributes.MailFromDomainStatus` → MX and SPF records with the same mapping.
  - DMARC: SES does not check it. Resolve `_dmarc.<name>` TXT with `node:dns/promises`; VERIFIED
    if any TXT starts with `v=DMARC1`, else PENDING. DNS errors → PENDING, never throw.
  - Domain status: VERIFIED when DKIM status is SUCCESS **and** MAIL FROM status is SUCCESS.
    FAILED when either is FAILED. TEMPORARY_FAILURE when either is TEMPORARY_FAILURE.
    Otherwise PENDING. `error` carries the provider's failure reason if any.
  - `NotFoundException` → status FAILED, error "identity not found at provider".
- `deleteDomain`: `DeleteEmailIdentityCommand`; swallow `NotFoundException`.

## 3. Domain service (`apps/api/src/domains.ts`, new)

Single module used by both public and admin routes and by the poller.

- `normalizeDomainName(input)` → lowercase, trim, strip trailing dot; reject unless it is a
  valid hostname with ≥ 2 labels, no scheme, no `@`, no wildcard. Error `invalid_domain`.
- `createDomain({ name, projectId, carrierId? })`:
  - Resolve carrier: explicit `carrierId` (admin only) else the default carrier
    (`isDefault = true`, `enabled = true`); none → 409 `no_default_carrier`.
  - `name` already exists → 409 `domain_exists` (unique constraint; catch P2002).
  - Provisioning carrier: `mailFromDomain = "send." + name`; call `carrier.domains.createDomain`;
    store records, `status = PENDING`. If the provider call throws, do **not** create the row;
    return 502 `provider_error` with the provider message.
  - Manual carrier (no `domains`): `status = VERIFIED`, `verifiedAt = now()`, `dnsRecords = []`,
    `mailFromDomain = null`.
- `checkDomain(id)`:
  - Manual carrier → no-op, returns the row.
  - Provisioning carrier → `carrier.domains.checkDomain`; update `status`, `dnsRecords`,
    `lastCheckedAt`, `verificationError`; set `verifiedAt = now()` the first time status
    becomes VERIFIED; clear `verificationError` when VERIFIED.
  - Expiry: if `status` is PENDING/TEMPORARY_FAILURE and `createdAt` is older than 72 h → set
    FAILED with `verificationError = "verification window expired (72h); re-verify to restart"`.
    A manual `verify` call on a FAILED domain resets `createdAt = now()` and re-checks (this is
    how a user restarts, matching Resend).
- `deleteDomain(id)`:
  - If any `Message` references the domain → 409 `domain_in_use` (Message.domainId is a
    required FK; do not cascade).
  - Provisioning carrier → `carrier.domains.deleteDomain` (best effort, log on failure),
    then delete the row.
- `toPublicDomain(row)` — the wire shape used by every endpoint:

```json
{
  "id": "…", "name": "example.com", "status": "pending",
  "carrier": { "id": "…", "name": "ses-mailroom", "type": "SES" },
  "project_id": "…",
  "mail_from_domain": "send.example.com",
  "records": [ { "type": "CNAME", "name": "…", "value": "…", "priority": null, "ttl": 300,
                 "purpose": "dkim", "required": true, "status": "pending" } ],
  "verified_at": null, "last_checked_at": null, "verification_error": null,
  "created_at": "2026-09-04T…Z"
}
```

  Enum values are lower-cased on the wire (`pending|verified|failed|temporary_failure`,
  `dkim|mail_from_mx|mail_from_spf|dmarc`). Public API is snake_case like `/v1/emails`
  (D-05); admin API returns the same object.

## 4. Public API (API-key auth, project-scoped) — `apps/api/src/routes/domains.ts`

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/v1/domains` | body `{ "name": "example.com" }`. Always uses the default carrier. 201 → domain object. |
| `GET` | `/v1/domains` | List the project's domains (own `projectId` only; shared `projectId = null` domains are **not** listed). |
| `GET` | `/v1/domains/:id` | 404 unless the domain belongs to the key's project. |
| `POST` | `/v1/domains/:id/verify` | Runs `checkDomain` now; 200 → updated domain object. |
| `DELETE` | `/v1/domains/:id` | 204; 409 `domain_in_use` if messages reference it. |

Error body shape follows existing routes: `{ "error": "<code>", ... }`.

## 5. Admin API additions (`apps/api/src/routes/admin.ts`)

- `POST /v1/admin/domains` — body gains optional `carrierId` (defaults to default carrier),
  `projectId` (nullable = shared). Runs the same `createDomain` (provisions on SES). Keep
  `fallbackCarrierId`, `notes`.
- `POST /v1/admin/domains/:id/verify` — same as public verify.
- `DELETE /v1/admin/domains/:id` — now also deletes the provider identity; 409 if in use.
- `GET /v1/admin/domains` and `PATCH` return the full domain object (§3) plus `projectSlug`,
  `fallbackCarrierId`, `notes`.
- `GET /v1/admin/carriers` returns `isDefault`. `PATCH /v1/admin/carriers/:id` accepts
  `isDefault: true` (transactionally clears the flag on every other carrier; `false` just
  clears it). `POST /v1/admin/carriers` accepts `isDefault` too.
- `GET /v1/admin/carriers/:id/quota` — for SES carriers only: `GetAccountCommand` →
  `{ production_access: bool, max_24h_send, max_send_rate, sent_last_24h }`; other types 404.
  (Cheap and very useful while the account is in sandbox.)

## 6. Send gate (D-07 extension) — `apps/api/src/routes/emails.ts`

Immediately after the ownership check and before the carrier-enabled check:

```ts
if (domain.status !== "VERIFIED") {
  return { code: 403, body: { error: "domain_not_verified", domain: fromDomain, status: domain.status.toLowerCase() } };
}
```

## 7. Poller — BullMQ repeatable job

- `queue.ts`: `scheduleMaintenance()` also registers `maintenanceQueue.upsertJobScheduler("domain-verify", { pattern: "*/5 * * * *" })`.
- `worker.ts`: maintenance worker dispatches `domain-verify` → `verifyPendingDomains()` in
  `domains.ts`: for every domain with status `PENDING | TEMPORARY_FAILURE` whose carrier
  provisions, run `checkDomain`; log the outcome per domain; never let one failure abort the
  batch. Sequential, not parallel (SES API rate limits are modest).

## 8. Ops steps after deploy (main thread does these, not the implementer)

1. `PATCH /v1/admin/carriers/<ses-mailroom id> { "isDefault": true }`.
2. E2E: add `mail.amlify.au` for project `amlify`, publish the returned records on the
   amlify.au Cloudflare zone, poll verify, send a test message, confirm SNS `Delivery` event
   flows to `DELIVERED`.

## 9. Dashboard (`apps/web`)

- **Settings → Domains** list: columns Domain, Project, Carrier, Status (chip: verified =
  green, pending = amber, failed = red, temporary_failure = amber), Created. Row links to
  detail. "Add domain" form: project select (incl. Shared), domain name, carrier select
  defaulting to the default carrier (badge "default"), notes. Server Action → admin POST.
- **Settings → Domains → [id]** detail page (new route `settings/domains/[id]/page.tsx`):
  status header with `verified_at` / `last_checked_at` / `verification_error`; DNS records
  table — Type, Name, Value (+ CopyButton for both name and value), Priority, TTL, Purpose,
  Required, Status chip; "Verify DNS records" button (Server Action → admin verify) and
  "Delete domain" (confirm) — 409 shows "domain has messages; cannot delete". A one-line hint
  per record type for Cloudflare users: DKIM CNAMEs must be **DNS only** (grey cloud), not
  proxied.
- **Settings → Carriers**: show "default" badge; action "Make default"; for SES carriers a
  small quota panel from `/quota` (production access yes/no, 24h quota, sent).
- Keep existing conventions: Server Actions in `actions.ts`, `api()` helper, `StatusChip`
  style pills (add a `DomainStatusChip` or extend the existing chip with a class map).

## 10. SDK (`packages/client`)

Add to the `createMailroom()` object:

```ts
domains: {
  create(input: { name: string }): Promise<Domain>;
  list(): Promise<{ data: Domain[] }>;
  get(id: string): Promise<Domain>;
  verify(id: string): Promise<Domain>;
  remove(id: string): Promise<void>;
}
```

Export `Domain`, `DnsRecord`, `DomainStatus` types (camelCase in TS, converted from the
snake_case wire shape the same way emails are). Tests mock `fetch` like the existing ones.

## 11. Tests (vitest, beside modules in `__tests__/`) — minimum set

- `carriers/__tests__/ses.domains.test.ts`: with an injected fake client — createDomain builds
  the exact 6 records for `example.com` in `ap-southeast-2`; AlreadyExists falls through to
  Get; checkDomain status matrix (SUCCESS+SUCCESS→VERIFIED, FAILED→FAILED,
  TEMPORARY_FAILURE→TEMPORARY_FAILURE, PENDING→PENDING; DMARC lookup stubbed);
  deleteDomain swallows NotFound.
- `__tests__/domains.test.ts`: `normalizeDomainName` accept/reject table; 72h expiry rule;
  `toPublicDomain` wire shape (snake_case, lower-cased enums).
- Route tests for `/v1/domains` create/list/verify/delete with a mocked prisma + fake carrier
  (follow `routes/__tests__/messengers.test.ts` for the app/prisma mocking pattern).
- Send gate: unverified domain → 403 `domain_not_verified`.

## 12. Docs to update

- `docs/DESIGN.md` §5 Domain block + new §"Domain verification" describing the flow.
- `docs/decisions.md` D-14 — platform SES carrier is the default; Mailroom provisions and
  verifies sending domains via the carrier (Resend model); DKIM/SPF stay with the carrier.
- `README.md` Quickstart: "Add and verify your domain" step before the first send; "Amazon
  SES" carrier notes: IAM policy, configuration set + SNS wiring, sandbox limits, MAIL FROM.
- `CLAUDE.md`: drop the stale "Design stage — no code exists yet" line; add SES facts
  (sandbox 200/day + verified recipients only; Easy DKIM tokens; MAIL FROM `send.` subdomain;
  identity region-bound).
