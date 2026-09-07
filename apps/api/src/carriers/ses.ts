import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import * as sesv2 from "@aws-sdk/client-sesv2";
import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import type {
  Carrier,
  DnsRecord,
  DomainProvisioner,
  HookVerdict,
  NormalizedEvent,
  OutboundMessage,
  RawRequest,
  SesConfig,
} from "./types.js";
import type { DomainStatus, EventType } from "@prisma/client";

/**
 * SES carrier. Facts that are easy to get wrong (see CLAUDE.md / D-09):
 * - On AWS, SES sends and SNS only reports. The hook endpoint is an SNS HTTPS
 *   subscriber, and SNS messages MUST have their signature verified against the
 *   published certificate — an unverified endpoint accepts forged events.
 * - The SES event JSON arrives wrapped as a string in the SNS envelope's
 *   `Message` field.
 * - `SendEmailCommand` response `MessageId` is what later appears as
 *   `mail.messageId` in events → store it as providerMessageId.
 */

// ---------------------------------------------------------------------------
// SNS envelope + signature verification (implemented here; no extra deps).
// ---------------------------------------------------------------------------

interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  Token?: string;
  SubscribeURL?: string;
}

/** Only ever fetch certs (or SubscribeURLs) from https://sns.<region>.amazonaws.com. */
function validateSnsUrl(urlStr: unknown): URL | null {
  if (typeof urlStr !== "string") return null;
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return null;
  return url;
}

/**
 * Canonical string-to-sign per the SNS spec: "Name\nValue\n" pairs, keys in
 * this exact order, a key included only when present on the message.
 */
function snsStringToSign(msg: SnsEnvelope): string | null {
  const keys: (keyof SnsEnvelope)[] =
    msg.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : msg.Type === "SubscriptionConfirmation" || msg.Type === "UnsubscribeConfirmation"
        ? ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
        : [];
  if (!keys.length) return null;
  let out = "";
  for (const key of keys) {
    const value = msg[key];
    if (value == null) {
      if (key === "Subject") continue; // the only optional signed field
      return null; // any other missing signed field → unverifiable
    }
    out += `${key}\n${value}\n`;
  }
  return out;
}

/** Module-level cert cache — SNS reuses one signing cert for long stretches. */
const certCache = new Map<string, X509Certificate>();

async function signingCertificate(url: string): Promise<X509Certificate> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`signing certificate fetch failed: HTTP ${res.status}`);
  const cert = new X509Certificate(await res.text());
  certCache.set(url, cert);
  return cert;
}

/**
 * Verify an SNS message signature. SignatureVersion 1 = SHA1withRSA,
 * SignatureVersion 2 = SHA256withRSA. Returns a reason string on failure,
 * null on success.
 */
async function verifySnsSignature(msg: SnsEnvelope): Promise<string | null> {
  const algo =
    msg.SignatureVersion === "1" ? "sha1" : msg.SignatureVersion === "2" ? "sha256" : null;
  if (!algo) return `unsupported SignatureVersion "${msg.SignatureVersion}"`;
  if (typeof msg.Signature !== "string" || !msg.Signature) return "missing Signature";
  const certUrl = validateSnsUrl(msg.SigningCertURL);
  if (!certUrl) return "invalid SigningCertURL (must be https on sns.<region>.amazonaws.com)";
  if (!certUrl.pathname.endsWith(".pem")) return "SigningCertURL does not point at a .pem";
  const stringToSign = snsStringToSign(msg);
  if (stringToSign == null) return "message is missing signed fields";

  let cert: X509Certificate;
  try {
    cert = await signingCertificate(certUrl.href);
  } catch (err) {
    return `could not load signing certificate: ${(err as Error).message}`;
  }
  let valid = false;
  try {
    valid = cryptoVerify(
      algo,
      Buffer.from(stringToSign, "utf8"),
      cert.publicKey,
      Buffer.from(msg.Signature, "base64"),
    );
  } catch (err) {
    return `signature verification error: ${(err as Error).message}`;
  }
  return valid ? null : "signature does not match";
}

function snsEnvelopeFrom(raw: RawRequest): SnsEnvelope | null {
  if (raw.body && typeof raw.body === "object" && !Array.isArray(raw.body)) {
    return raw.body as SnsEnvelope;
  }
  // SNS posts with Content-Type text/plain, so the JSON parser may not have run.
  if (raw.rawBody) {
    try {
      const parsed = JSON.parse(raw.rawBody);
      if (parsed && typeof parsed === "object") return parsed as SnsEnvelope;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SES event → NormalizedEvent mapping.
// ---------------------------------------------------------------------------

const SUPPRESS: Partial<Record<EventType, NormalizedEvent["suppress"]>> = {
  BOUNCED: { reason: "HARD_BOUNCE" },
  COMPLAINED: { reason: "COMPLAINT" },
};

function pushPerRecipient(
  out: NormalizedEvent[],
  base: Omit<NormalizedEvent, "recipient" | "detail">,
  recipients: { email?: string; detail?: string }[],
  fallbackDetail?: string,
): void {
  if (!recipients.length) {
    out.push({ ...base, detail: fallbackDetail });
    return;
  }
  for (const r of recipients) {
    out.push({ ...base, recipient: r.email, detail: r.detail ?? fallbackDetail });
  }
}

function normalizeSesEvent(event: any, out: NormalizedEvent[]): void {
  // Configuration-set event publishing uses `eventType`; legacy feedback
  // notifications use `notificationType`. Accept both.
  const kind: string | undefined = event?.eventType ?? event?.notificationType;
  const mail = event?.mail ?? {};
  const providerMessageId = String(mail.messageId ?? "");
  if (!kind || !providerMessageId) return;

  const at = (own?: string): Date => new Date(own ?? mail.timestamp ?? Date.now());
  const base = { providerMessageId, providerRaw: event };
  // Open/Click carry no per-recipient attribution; only safe when 1 recipient.
  const soleDestination: string | undefined =
    Array.isArray(mail.destination) && mail.destination.length === 1
      ? String(mail.destination[0])
      : undefined;

  switch (kind) {
    case "Delivery": {
      const d = event.delivery ?? {};
      pushPerRecipient(
        out,
        { ...base, type: "DELIVERED", occurredAt: at(d.timestamp) },
        (d.recipients ?? []).map((email: unknown) => ({ email: String(email) })),
        d.smtpResponse ? String(d.smtpResponse) : undefined,
      );
      break;
    }
    case "Bounce": {
      const b = event.bounce ?? {};
      // Permanent → hard bounce + suppression. Transient (and Undetermined,
      // which SES could not classify) → DELAYED, never a suppression.
      const type: EventType = b.bounceType === "Permanent" ? "BOUNCED" : "DELAYED";
      pushPerRecipient(
        out,
        { ...base, type, occurredAt: at(b.timestamp), suppress: SUPPRESS[type] },
        (b.bouncedRecipients ?? []).map((r: any) => ({
          email: r?.emailAddress ? String(r.emailAddress) : undefined,
          detail: r?.diagnosticCode ? String(r.diagnosticCode) : undefined,
        })),
        [b.bounceType, b.bounceSubType].filter(Boolean).join("/") || undefined,
      );
      break;
    }
    case "Complaint": {
      const c = event.complaint ?? {};
      pushPerRecipient(
        out,
        { ...base, type: "COMPLAINED", occurredAt: at(c.timestamp), suppress: SUPPRESS.COMPLAINED },
        (c.complainedRecipients ?? []).map((r: any) => ({
          email: r?.emailAddress ? String(r.emailAddress) : undefined,
        })),
        c.complaintFeedbackType ? String(c.complaintFeedbackType) : undefined,
      );
      break;
    }
    case "Reject": {
      out.push({
        ...base,
        type: "FAILED",
        occurredAt: at(),
        recipient: soleDestination,
        detail: event.reject?.reason ? String(event.reject.reason) : undefined,
      });
      break;
    }
    case "Open": {
      const o = event.open ?? {};
      out.push({
        ...base,
        type: "OPENED",
        occurredAt: at(o.timestamp),
        recipient: soleDestination,
        detail: o.userAgent ? String(o.userAgent) : undefined,
      });
      break;
    }
    case "Click": {
      const c = event.click ?? {};
      out.push({
        ...base,
        type: "CLICKED",
        occurredAt: at(c.timestamp),
        recipient: soleDestination,
        detail: c.link ? String(c.link) : undefined,
      });
      break;
    }
    case "DeliveryDelay": {
      const d = event.deliveryDelay ?? {};
      pushPerRecipient(
        out,
        { ...base, type: "DELAYED", occurredAt: at(d.timestamp) },
        (d.delayedRecipients ?? []).map((r: any) => ({
          email: r?.emailAddress ? String(r.emailAddress) : undefined,
          detail: r?.diagnosticCode ? String(r.diagnosticCode) : undefined,
        })),
        d.delayType ? String(d.delayType) : undefined,
      );
      break;
    }
    default:
      // Send / RenderingFailure / Subscription and unknown types: log only —
      // SENT is recorded at send time, the rest have no normalized mapping.
      break;
  }
}

// ---------------------------------------------------------------------------
// Domain provisioning (Easy DKIM + custom MAIL FROM).
// ---------------------------------------------------------------------------

/** SES DkimStatus / MailFromDomainStatus, both use this vocabulary. */
type SesVerifyStatus = "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE" | "PENDING" | "NOT_STARTED";

/** Per-record status. TEMPORARY_FAILURE is a provider-side retry, not a record fault. */
function recordStatus(status: SesVerifyStatus | undefined): DnsRecord["status"] {
  switch (status) {
    case "SUCCESS":
      return "VERIFIED";
    case "FAILED":
      return "FAILED";
    default:
      // TEMPORARY_FAILURE, PENDING, NOT_STARTED and "no answer yet".
      return "PENDING";
  }
}

/**
 * The six records a Resend-style SES identity needs: three Easy DKIM CNAMEs,
 * the MAIL FROM MX + SPF pair (so SPF aligns with the From domain), and a
 * recommended DMARC policy SES itself never checks.
 */
function buildRecords(params: {
  name: string;
  mailFromDomain: string;
  region: string;
  tokens: string[];
  dkimStatus?: SesVerifyStatus;
  mailFromStatus?: SesVerifyStatus;
  dmarcStatus?: DnsRecord["status"];
}): DnsRecord[] {
  const dkim = recordStatus(params.dkimStatus);
  const mailFrom = recordStatus(params.mailFromStatus);
  const records: DnsRecord[] = params.tokens.map((token) => ({
    type: "CNAME",
    name: `${token}._domainkey.${params.name}`,
    value: `${token}.dkim.amazonses.com`,
    ttl: 300,
    purpose: "DKIM",
    required: true,
    status: dkim,
  }));
  records.push({
    type: "MX",
    name: params.mailFromDomain,
    value: `feedback-smtp.${params.region}.amazonses.com`,
    priority: 10,
    ttl: 300,
    purpose: "MAIL_FROM_MX",
    required: true,
    status: mailFrom,
  });
  records.push({
    type: "TXT",
    name: params.mailFromDomain,
    value: "v=spf1 include:amazonses.com ~all",
    ttl: 300,
    purpose: "MAIL_FROM_SPF",
    required: true,
    status: mailFrom,
  });
  records.push({
    type: "TXT",
    name: `_dmarc.${params.name}`,
    value: "v=DMARC1; p=none;",
    ttl: 300,
    purpose: "DMARC",
    required: false,
    status: params.dmarcStatus ?? "PENDING",
  });
  return records;
}

/** SES never reports DMARC, so resolve it ourselves. DNS errors are not failures. */
async function dmarcStatus(
  name: string,
  resolveTxt: (hostname: string) => Promise<string[][]>,
): Promise<DnsRecord["status"]> {
  try {
    const answers = await resolveTxt(`_dmarc.${name}`);
    const found = answers.some((chunks) => chunks.join("").trim().toLowerCase().startsWith("v=dmarc1"));
    return found ? "VERIFIED" : "PENDING";
  } catch {
    return "PENDING";
  }
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof AlreadyExistsException || (err as { name?: string })?.name === "AlreadyExistsException";
}

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundException || (err as { name?: string })?.name === "NotFoundException";
}

function createSesDomainProvisioner(
  client: SESv2Client,
  config: SesConfig,
  resolveTxt: (hostname: string) => Promise<string[][]>,
): DomainProvisioner {
  return {
    // SES needs a custom MAIL FROM subdomain so SPF aligns with the From domain.
    mailFromFor(name) {
      return `send.${name}`;
    },

    async createDomain(name, opts) {
      let tokens: string[] = [];
      try {
        const res = await client.send(
          new CreateEmailIdentityCommand({
            EmailIdentity: name,
            ConfigurationSetName: config.configurationSet,
            DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
          }),
        );
        tokens = res.DkimAttributes?.Tokens ?? [];
      } catch (err) {
        // Idempotent: an identity we (or someone) already created still has to
        // hand back its DKIM tokens.
        if (!isAlreadyExists(err)) throw err;
        const existing = await client.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
        tokens = existing.DkimAttributes?.Tokens ?? [];
      }

      await client.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: name,
          MailFromDomain: opts.mailFromDomain,
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        }),
      );

      return {
        records: buildRecords({
          name,
          mailFromDomain: opts.mailFromDomain,
          region: config.region,
          tokens,
        }),
      };
    },

    async checkDomain(name, opts) {
      let res;
      try {
        res = await client.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
      } catch (err) {
        if (isNotFound(err)) {
          return { status: "FAILED" as DomainStatus, records: [], error: "identity not found at provider" };
        }
        throw err;
      }

      const dkim = res.DkimAttributes?.Status as SesVerifyStatus | undefined;
      const mailFrom = res.MailFromAttributes?.MailFromDomainStatus as SesVerifyStatus | undefined;
      const dmarc = await dmarcStatus(name, resolveTxt);

      const records = buildRecords({
        name,
        mailFromDomain: res.MailFromAttributes?.MailFromDomain ?? opts.mailFromDomain,
        region: config.region,
        tokens: res.DkimAttributes?.Tokens ?? [],
        dkimStatus: dkim,
        mailFromStatus: mailFrom,
        dmarcStatus: dmarc,
      });

      let status: DomainStatus;
      let error: string | undefined;
      if (dkim === "SUCCESS" && mailFrom === "SUCCESS") {
        status = "VERIFIED";
      } else if (dkim === "FAILED" || mailFrom === "FAILED") {
        status = "FAILED";
        error = [
          dkim === "FAILED" ? "DKIM verification failed" : null,
          mailFrom === "FAILED" ? "MAIL FROM verification failed" : null,
        ]
          .filter(Boolean)
          .join("; ");
      } else if (dkim === "TEMPORARY_FAILURE" || mailFrom === "TEMPORARY_FAILURE") {
        status = "TEMPORARY_FAILURE";
        error = "provider reported a temporary failure; still retrying";
      } else {
        status = "PENDING";
      }
      return { status, records, error };
    },

    async deleteDomain(name) {
      try {
        await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: name }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Carrier
// ---------------------------------------------------------------------------

export interface SesCarrierDeps {
  /** Injected in tests so no AWS call is ever made. */
  client?: SESv2Client;
  /** Injected in tests; defaults to node:dns/promises resolveTxt. */
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}

export function createSesCarrier(config: SesConfig, deps: SesCarrierDeps = {}): Carrier {
  const client =
    deps.client ??
    new SESv2Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  const resolveTxt = deps.resolveTxt ?? dnsResolveTxt;

  return {
    type: "ses",

    domains: createSesDomainProvisioner(client, config, resolveTxt),

    async accountQuota() {
      const res = await client.send(new GetAccountCommand({}));
      return {
        production_access: res.ProductionAccessEnabled ?? false,
        max_24h_send: res.SendQuota?.Max24HourSend ?? null,
        max_send_rate: res.SendQuota?.MaxSendRate ?? null,
        sent_last_24h: res.SendQuota?.SentLast24Hours ?? null,
      };
    },

    async send(msg: OutboundMessage) {
      if (msg.attachments.length && !("AttachmentContentDisposition" in sesv2)) {
        // Simple-content Attachments landed in @aws-sdk/client-sesv2 3.658.0
        // (Sept 2024). Older SDKs silently drop unknown fields — refuse instead.
        throw new Error(
          "attachments not supported: installed @aws-sdk/client-sesv2 predates Simple-content Attachments (needs >= 3.658.0)",
        );
      }
      const headers = Object.entries(msg.headers);
      const input: SendEmailCommandInput = {
        FromEmailAddress: msg.from,
        Destination: {
          ToAddresses: msg.to,
          CcAddresses: msg.cc.length ? msg.cc : undefined,
          BccAddresses: msg.bcc.length ? msg.bcc : undefined,
        },
        ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
        ConfigurationSetName: config.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: "UTF-8" },
            Body: {
              Html: msg.html ? { Data: msg.html, Charset: "UTF-8" } : undefined,
              Text: msg.text ? { Data: msg.text, Charset: "UTF-8" } : undefined,
            },
            Headers: headers.length
              ? headers.map(([Name, Value]) => ({ Name, Value }))
              : undefined,
            Attachments: msg.attachments.length
              ? msg.attachments.map((a) => ({
                  FileName: a.filename,
                  ContentType: a.contentType,
                  RawContent: Buffer.from(a.content, "base64"),
                }))
              : undefined,
          },
        },
      };
      const res = await client.send(new SendEmailCommand(input));
      if (!res.MessageId) throw new Error("SES SendEmail returned no MessageId");
      return { providerMessageId: res.MessageId };
    },

    async verifyHook(raw: RawRequest): Promise<HookVerdict> {
      const msg = snsEnvelopeFrom(raw);
      if (!msg) return { ok: false, reason: "body is not an SNS message" };

      const failure = await verifySnsSignature(msg);
      if (failure) return { ok: false, reason: failure };

      if (msg.Type === "SubscriptionConfirmation") {
        const subscribeUrl = validateSnsUrl(msg.SubscribeURL);
        if (!subscribeUrl) {
          return { ok: false, reason: "invalid SubscribeURL" };
        }
        const res = await fetch(subscribeUrl.href);
        if (!res.ok) {
          return { ok: false, reason: `subscription confirmation failed: HTTP ${res.status}` };
        }
        return { ok: true, respondWith: { ok: true } };
      }
      if (msg.Type === "Notification" || msg.Type === "UnsubscribeConfirmation") {
        return { ok: true };
      }
      return { ok: false, reason: `unexpected SNS message type "${msg.Type}"` };
    },

    parseEvents(payload: unknown): NormalizedEvent[] {
      const out: NormalizedEvent[] = [];
      const envelopes = Array.isArray(payload) ? payload : [payload];
      for (const envelope of envelopes as any[]) {
        if (!envelope || typeof envelope !== "object") continue;
        let sesEvent: unknown = envelope;
        if (typeof envelope.Message === "string") {
          // SNS envelope: the SES event JSON is the Message string.
          if (envelope.Type && envelope.Type !== "Notification") continue;
          try {
            sesEvent = JSON.parse(envelope.Message);
          } catch {
            continue; // e.g. the "Successfully validated..." confirmation text
          }
        }
        normalizeSesEvent(sesEvent, out);
      }
      return out;
    },
  };
}
