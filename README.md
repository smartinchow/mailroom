# Mailroom

Self-hosted transactional email service. Your mailroom, your carriers, your logs.

One deployment fronts many applications and many sending domains. Applications call a
Resend-shaped HTTP API; Mailroom queues, rate-limits, sends via a pluggable **carrier**
(Azure Communication Services, Amazon SES, or plain SMTP), ingests the carrier's delivery
events, and keeps a searchable log — including the rendered message body.

**Status: design only.** No code yet. Start at [`docs/DESIGN.md`](docs/DESIGN.md).

## Why

Every existing open-source "self-hosted Resend" is locked to Amazon SES
([useSend](https://github.com/usesend/usesend), [FreeResend](https://www.freeresend.com/),
[Plunk](https://github.com/useplunk/plunk), [sesdashboard](https://github.com/Nikeev/sesdashboard)),
or it is its own MTA ([Postal](https://github.com/postalserver/postal),
[Cuttlefish](https://github.com/mlandauer/cuttlefish)). Nothing supports Azure
Communication Services, and nothing lets one deployment route different domains to
different carriers.

Mailroom is deliberately **not an MTA**. It does not run Postfix, warm IPs, or sign DKIM.
The carrier does all of that. Mailroom is the thin layer the carriers don't give you:
a send API, a queue with real rate limits, a normalised event log, a shared suppression
list, and a dashboard where you can actually see what was sent.

## What it is not

- Not a marketing/campaign tool — that's Listmonk's job.
- Not an inbound mail server. ACS cannot receive mail at all.
- Not a template designer. Applications own their HTML.

## Shape

```
your app ──POST /v1/emails──▶ Mailroom API ──▶ queue ──▶ carrier (ACS | SES | SMTP)
                                   ▲                          │
                                   └── /v1/hooks/{acs,ses} ◀──┘  delivery events
                              dashboard: log, status, body preview
```

## Licence

Undecided — AGPL-3.0 proposed. See `docs/decisions.md` D-08.
