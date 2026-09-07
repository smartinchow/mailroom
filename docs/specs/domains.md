# Spec — Mailroom-managed sending domains (Resend model on Amazon SES / Azure Communication Services)

Status: approved for implementation 2026-09-04; extended to ACS provisioning 2026-09-08
(D-15). Owner: Mailroom.

## Goal

Any project can add its own sending domain to Mailroom, receive the DNS records it must
publish, and have Mailroom verify the domain against the carrier — exactly the flow
resend.com offers. Two carriers now provision domains this way: Amazon SES (`ses-mailroom`,
the Consultin AWS account, region `ap-southeast-2`, configuration set `mailroom`) and Azure
Communication Services (`amlify-acs`, over Azure Resource Manager). Exactly one carrier is
flagged `isDefault` and new domains provision against it; as of D-15 that carrier is ACS.
SMTP carriers keep working unchanged.

Non-goals: Mailroom never signs DKIM or touches DNS itself (D-03). No automatic DNS
publishing to registrars in this iteration.

## Terminology

- **Provisioning carrier** — a carrier whose adapter implements `domains` (below). SES and
  ACS (when configured with ARM credentials, `AcsArmConfig`) both provision. SMTP does not;
  domains on it are "manual" — verified at creation, no records, no polling.
- **MAIL FROM domain** — the domain SPF must align against. Providers disagree on the
  convention, which is why `DomainProvisioner` carries a `mailFromFor(name)` method:
  - **SES**: a custom MAIL FROM subdomain, always `send.<domain>` (Resend uses the same
    name).
  - **ACS**: no custom MAIL FROM subdomain exists. `mail_from_domain` equals the sending
    domain itself — ACS publishes its SPF TXT directly on `<domain>`, not on a subdomain.

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
  purpose: "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC" | "DOMAIN_OWNERSHIP";
  required: boolean;   // DMARC is recommended, not required
  status: "PENDING" | "VERIFIED" | "FAILED" | "NOT_STARTED";
}
```

`DOMAIN_OWNERSHIP` is ACS-only — the ownership TXT ACS requires before it will start SPF/
DKIM/DKIM2 verification (see the ACS implementation below). SES has no equivalent record.

## 2. Carrier contract extension (`apps/api/src/carriers/types.ts`)

```ts
export interface DomainProvisioner {
  /**
   * The MAIL FROM domain this provider wants for `name`. Providers disagree
   * (see Terminology above), so `domains.ts` asks rather than assumes —
   * keeping the difference inside `carriers/` per the no-provider-branches
   * rule.
   */
  mailFromFor(name: string): string;
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

### ACS implementation (`apps/api/src/carriers/acs-domains.ts`)

Added under D-15, alongside the platform default carrier moving to ACS. Talks raw Azure
Resource Manager REST (api-version `2023-04-01`) through an injectable `fetch` — ACS has no
management-plane SDK worth a dependency here — against the existing `amlify-email` /
`amlify-acs` resources in `rg-amlify-email`. Present only when the carrier's config
(`AcsConfig.arm`, typed `AcsArmConfig`) carries Entra service-principal credentials; an ACS
carrier configured without `arm` has no `domains` and stays a manual carrier exactly as
before D-15.

- `mailFromFor(name)` returns `name` unchanged — ACS has no custom MAIL FROM subdomain (see
  Terminology above). This is the one place the SES and ACS provisioners genuinely diverge
  in shape, which is why `mailFromFor` exists on the interface at all.
- `createDomain`: `PUT .../domains/<name>` (upsert — an existing domain is updated in place
  and still returns its records, satisfying the idempotency the contract requires), then
  immediately calls `initiateVerification` for `Domain` only. Ownership is the gate on
  everything else (below), so there is nothing else to start yet.
- **Verification ordering — Domain before SPF/DKIM/DKIM2.** ACS reports four independent
  verification types — `Domain` (ownership TXT), `SPF` (TXT), `DKIM` and `DKIM2` (CNAMEs) —
  but refuses to accept an `initiateVerification` call for SPF/DKIM/DKIM2 until `Domain`
  itself reports `Verified`. `checkDomain` therefore runs a small state machine on every
  poll rather than a single status check: if `Domain` is not started, (re-)start it; once
  `Domain` is `Verified`, start any of SPF/DKIM/DKIM2 that are not yet started. A rejected
  `initiateVerification` call (wrong prerequisite, already in flight) is swallowed, not
  fatal — the next 5-minute poll retries. `DnsRecord.purpose` maps `Domain` → the new
  `DOMAIN_OWNERSHIP`, `SPF` → `MAIL_FROM_SPF`, `DKIM`/`DKIM2` → `DKIM` (two records, same
  purpose). All four are `required: true`; there is no DMARC record on ACS at all (neither
  issued nor checked).
- ACS record names come back **relative** to the domain (e.g.
  `selector1-azurecomm-prod-net._domainkey`, or `@`/empty for the apex) — `qualify()`
  fully-qualifies them before they go on `DnsRecord.name`, which is documented FQDN-only.
- `checkDomain` status mapping: any record `VerificationFailed` → domain `FAILED` (error
  lists which record and ACS's error code); all four `Verified` → domain `VERIFIED`;
  otherwise `PENDING`. An ARM call that fails with 429 or 5xx maps to `TEMPORARY_FAILURE`
  (never treated as a record the customer got wrong); ARM 404 on the domain resource maps to
  `FAILED` with "domain not found at provider".
- **Two side effects only run once every record is `Verified`**, both idempotent so
  repeating them on a later check of an already-verified domain is harmless:
  1. `ensureSenderUsernames` — `PUT` (upsert) `noreply` and `donotreply` sender usernames on
     the domain. ACS refuses to send from a username that isn't registered, so this is part
     of making a freshly verified domain actually usable, not an afterthought.
  2. `link(name)` — add the domain's ARM resource id to the Communication Service's
     `linkedDomains`. **This is a read-modify-write, not a plain write.** The ARM PATCH
     replaces the entire `linkedDomains` array; the implementation always `GET`s the current
     array first and appends, because a blind write would unlink every other live sending
     domain already on `amlify-acs`. `deleteDomain` mirrors this with `unlink`, which reads
     the array and filters out only its own entry.
- `deleteDomain`: unlinks first (ARM refuses to delete a domain still linked to the
  Communication Service), then `DELETE`s the domain resource. Both steps swallow 404 —
  "already gone" is success, per the contract.
- Long-running ARM operations (the domain PUT, `initiateVerification`, sender-username PUT,
  the DELETE) are followed via the `Azure-AsyncOperation` header, bounded to 20 attempts at
  1.5s apiece so a stuck ARM operation is left to the next poll rather than wedging a worker.

## 3. Domain service (`apps/api/src/domains.ts`, new)

Single module used by both public and admin routes and by the poller.

- `normalizeDomainName(input)` → lowercase, trim, strip trailing dot; reject unless it is a
  valid hostname with ≥ 2 labels, no scheme, no `@`, no wildcard. Error `invalid_domain`.
- `createDomain({ name, projectId, carrierId? })`:
  - Resolve carrier: explicit `carrierId` (admin only) else the default carrier
    (`isDefault = true`, `enabled = true`); none → 409 `no_default_carrier`.
  - `name` already exists → 409 `domain_exists` (unique constraint; catch P2002).
  - Provisioning carrier: `mailFromDomain = carrier.domains.mailFromFor(name)` (`send.<name>`
    on SES; `name` itself on ACS — never hardcoded in `domains.ts`); call
    `carrier.domains.createDomain`; store records, `status = PENDING`. If the provider call
    throws, do **not** create the row; return 502 `provider_error` with the provider message.
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
  `projectId` (nullable = shared). Runs the same `createDomain` (provisions on whichever
  carrier is resolved — SES or ACS; a no-op to VERIFIED on SMTP). Keep `fallbackCarrierId`,
  `notes`.
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

Superseded by D-15: the default carrier is now `amlify-acs`, not `ses-mailroom`
(`PATCH /v1/admin/carriers/<amlify-acs id> { "isDefault": true }`). The E2E in step 2 is the
same shape against ACS: publish the four ACS records (merging the SPF include per the SPF
merge hazard in `CLAUDE.md` if the domain already sends mail elsewhere), poll verify, send a
test message, confirm the Event Grid `Delivered` event flows through.

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

Added under D-15: `carriers/__tests__/acs.domains.test.ts` covering `qualify()`,
`buildRecords()`, the Domain-before-SPF/DKIM/DKIM2 ordering, the `linkedDomains`
read-modify-write (link and unlink each preserve unrelated entries), and the
TEMPORARY_FAILURE mapping for 429/5xx ARM responses — with `fetch`, `sleep` and `now` all
injected per `AcsDomainProvisionerDeps`, no live ARM call.

## 12. Docs to update

- `docs/DESIGN.md` §5 Domain block + new §"Domain verification" describing the flow.
- `docs/decisions.md` D-14 — platform SES carrier is the default; Mailroom provisions and
  verifies sending domains via the carrier (Resend model); DKIM/SPF stay with the carrier.
- `README.md` Quickstart: "Add and verify your domain" step before the first send; "Amazon
  SES" carrier notes: IAM policy, configuration set + SNS wiring, sandbox limits, MAIL FROM.
- `CLAUDE.md`: drop the stale "Design stage — no code exists yet" line; add SES facts
  (sandbox 200/day + verified recipients only; Easy DKIM tokens; MAIL FROM `send.` subdomain;
  identity region-bound).
