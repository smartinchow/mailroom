# Decision log

Short records of the calls made during design, and what was rejected. Each entry keeps the
alternative on file so a future reader doesn't re-litigate it — or, if circumstances
change, knows exactly which assumption to revisit.

---

## D-01 — Build rather than adopt an existing project

**Decided: build.**

Surveyed the field first. Every self-hosted "Resend alternative" is bound to Amazon SES:
[useSend](https://github.com/usesend/usesend) ("depends on AWS SES to send and SNS to
receive email status"), [FreeResend](https://www.freeresend.com/),
[Plunk](https://github.com/useplunk/plunk),
[sesdashboard](https://github.com/Nikeev/sesdashboard).
[senlo](https://github.com/IgorFilippov3/senlo) is provider-agnostic (SES / Resend /
Mailgun / SMTP, AGPL-3.0, multi-project isolation) but MVP-stage and does not document
content logging. [Postal](https://github.com/postalserver/postal),
[Cuttlefish](https://github.com/mlandauer/cuttlefish) and
[hyvor/relay](https://github.com/hyvor/relay) are their own MTAs — they replace a carrier
rather than front one.

None support Azure Communication Services. ACS *can* be fronted over its SMTP relay by
anything with a generic SMTP transport, but the event half then dangles: nothing ingests
Event Grid, so every row sits at "sent, status unknown" forever. Fixing that means an
adapter inside someone else's codebase plus a fork to maintain.

**Rejected:** deploy useSend on SES and add ACS later. Genuinely less work (about a day
versus about a week) and it brings a dashboard, multi-domain and per-project keys for free.
Revisit if Mailroom stalls before M2.

## D-02 — ACS is the primary carrier

**Decided: ACS first, SES second.**

Reason is commercial, not technical: available Azure credit. Recorded plainly because the
technical comparison points slightly the other way and should not be re-discovered as a
surprise:

- ACS costs $0.00025/email + $0.00012/MB. SES costs $0.0001/email ($0.10 per 1,000) +
  $0.12/GB attachments. **ACS is ~2.5× SES per email** — about $12.50 versus $5 at 50k/mo.
  Noise in absolute terms.
- **SES runs in `ap-southeast-2` (Sydney)**, so Australian data residency is *not* an
  ACS-exclusive advantage. If residency were the only driver, SES would win on cost,
  ecosystem and available tooling.
- ACS is thinner: no inbound mail at all, no dedicated-IP product, no deliverability
  dashboard equivalent to SES's Virtual Deliverability Manager, and low default quotas
  (~100/hour on a new resource) raised only by support ticket.
- ACS deliverability itself is fine — it rides Microsoft's Exchange infrastructure, which
  is why ACS-verified domains publish `include:spf.protection.outlook.com`.

Because the carrier interface is small and SES is a first-class second adapter, this
decision is cheap to reverse: change a domain's `carrierId`.

## D-03 — Not an MTA

**Decided: front a carrier; never deliver mail ourselves.**

No Postfix, no IP warming, no DKIM key management, no reputation work. Those are the parts
ACS and SES already do well and the parts that turn a side project into an operations
burden. Mailroom owns only what carriers don't give you: send API, queue with real rate
limits, normalised event log, shared suppression, dashboard.

## D-04 — Standalone service, not a shared library

**Decided: one deployment with an HTTP API.**

A library embedded per application would log into each application's own database — which
defeats the point, since the requirement is *one place to look* across several projects and
domains. A service also centralises the suppression list and the retention policy, and lets
carrier credentials rotate without redeploying every consumer.

## D-05 — Resend-shaped API

**Decided: mirror Resend's request JSON.**

`{from, to, subject, html, text, reply_to, cc, bcc, headers}` with a `Bearer` key. Makes
adoption a transport swap rather than a rewrite of every call site, and makes rollback to
Resend trivial during migration. FreeResend demonstrates the approach works.

## D-06 — Redact bodies by default

**Decided: `bodyRetention: redacted` is the default; `full` is opt-in per project.**

Stored HTML carries live credentials — magic links and invite/share tokens. A verbatim body
log is a credential store with a web UI in front of it. Redacting token-bearing URL
components keeps the log useful for "what did we actually say to this customer" while
removing the takeover path. Paired with a nightly purge (90 days default), sandboxed
rendering, click-to-load images, and no bulk body export.

**Rejected:** store nothing (loses the entire reason for the project); store everything and
rely on access control alone (one leaked session is then a full compromise).

## D-07 — Reject cross-project `from` domains

**Decided: an API key may only send from domains bound to its project.**

Without it, any project's key can send as any other project's domain. Cheap to enforce at
send time, impossible to retrofit trust after an incident.

## D-08 — Licence: open, AGPL-3.0 proposed

**Not yet decided.**

AGPL-3.0 matches the peer set (senlo) and discourages someone hosting it as a paid service
without contributing back. It constrains only modification-plus-network-distribution, so
internal use is unaffected. Apache-2.0 would attract wider corporate adoption at the cost
of that protection. Choose before the first public commit — relicensing later needs every
contributor's agreement.

## D-09 — SNS is the event half, not the send half

**Noted, to prevent a wrong build.**

The original framing was "support ACS and AWS SNS". On AWS, sending is the **SES** API (or
SES SMTP); SNS is only one of several event destinations for delivery notifications
(EventBridge and Kinesis Firehose are the others). Mailroom's SES adapter therefore pairs
`SendEmailCommand` with a configuration set whose event destination is an SNS topic
delivering to `/v1/hooks/ses/:secret` — with signature verification, since an unverified
SNS endpoint accepts forged notifications from anyone.

## D-10 — Licence: AGPL-3.0

**Decided: AGPL-3.0-only** (2026-08-27, implementation start). Matches the peer set,
discourages a hosted rip; internal use unaffected. LICENSE committed before first push.

## D-11 — v1 admin auth: env password + shared admin token

**Decided.** Dashboard login is a single operator password (`ADMIN_PASSWORD` env) with a
signed HttpOnly session cookie; the web app calls the API's `/v1/admin/*` with a shared
`ADMIN_API_TOKEN` that never reaches the browser. TOTP and OIDC (design §10) deferred to a
later milestone — v1 is a single operator behind TLS. Rejected for v1: full user table
(overkill), GitHub-OAuth-only (the useSend complaint).

## D-12 — Verbatim send body lives in a Redis stash, not the database

**Decided.** The database only ever holds the policy-filtered body (D-06). The carrier
must still send the original, so the API stashes the verbatim body + attachments in Redis
(`sendbody:<id>`, TTL 7 days) and the worker deletes it after a successful send or final
failure. If the stash is lost (Redis flush) the worker falls back to the stored, possibly
redacted, body rather than dropping the send.

## D-13 — ACS send waits for the LRO to complete

**Decided.** `@azure/communication-email` only exposes the operation id (== Event Grid
`data.messageId`) once the long-running operation reaches a terminal state, so the worker
calls `pollUntilDone()`. Blocking a worker slot for seconds is irrelevant at ACS quota
scale (~100/hour), and it gives a definitive send success/failure per attempt. Rejected:
reading the undocumented `operationLocation` from poller internals (breaks across SDK
versions).
