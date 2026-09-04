import type { DomainStatus, EventType } from "@prisma/client";

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  /** base64 */
  content: string;
}

export interface OutboundMessage {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  attachments: OutboundAttachment[];
}

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body (Event Grid / SNS both deliver JSON). */
  body: unknown;
  /** Raw body string, for signature verification where needed. */
  rawBody?: string;
}

export type HookVerdict =
  | { ok: true }
  | { ok: true; respondWith: unknown }
  | { ok: false; reason: string };

export interface NormalizedEvent {
  /** Carrier's message id — matched to Message.providerMessageId. */
  providerMessageId: string;
  type: EventType;
  recipient?: string;
  occurredAt: Date;
  /** Provider's raw event, stored verbatim on the MessageEvent. */
  providerRaw: unknown;
  /** When set, ingest adds a suppression (hard bounce / complaint). */
  suppress?: { reason: "HARD_BOUNCE" | "COMPLAINT" };
  /** Free-text detail (bounce reason etc), lands in Message.lastError for failures. */
  detail?: string;
}

/**
 * One DNS record the domain owner must publish. Stored verbatim on
 * `Domain.dnsRecords` and returned verbatim on the wire.
 */
export interface DnsRecord {
  type: "CNAME" | "MX" | "TXT";
  /** Fully qualified, no trailing dot, e.g. "abc._domainkey.example.com". */
  name: string;
  value: string;
  /** MX only (10). */
  priority?: number;
  /** Suggested TTL, informational. */
  ttl?: number;
  purpose: "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC";
  /** DMARC is recommended, not required. */
  required: boolean;
  status: "PENDING" | "VERIFIED" | "FAILED" | "NOT_STARTED";
}

/**
 * Optional carrier capability: registering and verifying a sending identity
 * with the provider. SES implements it; ACS and SMTP do not — domains on
 * those carriers are "manual" and go straight to VERIFIED.
 */
export interface DomainProvisioner {
  /** Register the identity with the provider. Idempotent: if it already exists, return its records. */
  createDomain(name: string, opts: { mailFromDomain: string }): Promise<{ records: DnsRecord[] }>;
  /** Ask the provider for the current verification state and per-record status. */
  checkDomain(
    name: string,
    opts: { mailFromDomain: string },
  ): Promise<{ status: DomainStatus; records: DnsRecord[]; error?: string }>;
  /** Remove the identity. Must not throw if it is already gone. */
  deleteDomain(name: string): Promise<void>;
}

/**
 * Provider account sending limits. Only carriers that can report them
 * implement `accountQuota` — the admin quota endpoint 404s for the rest,
 * which keeps the provider branch inside `carriers/`.
 */
export interface CarrierAccountQuota {
  production_access: boolean;
  max_24h_send: number | null;
  max_send_rate: number | null;
  sent_last_24h: number | null;
}

export interface Carrier {
  readonly type: "acs" | "ses" | "smtp";
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  /** Handshake + authenticity. Returns a body to echo, or a verdict. */
  verifyHook(raw: RawRequest): Promise<HookVerdict>;
  parseEvents(payload: unknown): NormalizedEvent[];
  /** Present only on provisioning carriers (SES). */
  domains?: DomainProvisioner;
  /** Present only on carriers that expose account sending limits (SES). */
  accountQuota?(): Promise<CarrierAccountQuota>;
}

/** Decrypted per-carrier configuration shapes (stored AES-256-GCM in Carrier.configEnc). */
export interface AcsConfig {
  type: "acs";
  connectionString: string;
  /** ACS resource id, asserted against Event Grid `topic` on ingest. */
  resourceId: string;
}

export interface SesConfig {
  type: "ses";
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  configurationSet?: string;
}

export interface SmtpConfig {
  type: "smtp";
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export type CarrierConfig = AcsConfig | SesConfig | SmtpConfig;
