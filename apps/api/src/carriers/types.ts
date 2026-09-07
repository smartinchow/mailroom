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
  /** DOMAIN_OWNERSHIP is the ACS domain-verification TXT; SES has no equivalent. */
  purpose: "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC" | "DOMAIN_OWNERSHIP";
  /** DMARC is recommended, not required. */
  required: boolean;
  status: "PENDING" | "VERIFIED" | "FAILED" | "NOT_STARTED";
  /**
   * Operator-facing explanation, set only when the carrier rewrote the value it
   * would otherwise have handed back (ACS merging its include into an SPF
   * record the domain already publishes). Free text; nothing branches on it.
   */
  note?: string;
}

/**
 * Optional carrier capability: registering and verifying a sending identity
 * with the provider. SES and ACS (when given ARM credentials) implement it;
 * SMTP does not — domains on it are "manual" and go straight to VERIFIED.
 */
export interface DomainProvisioner {
  /**
   * The MAIL FROM domain this provider wants for `name`. Providers disagree:
   * SES needs a custom MAIL FROM subdomain (`send.<name>`) so SPF aligns with
   * the From domain, while ACS has no custom MAIL FROM at all and publishes
   * its SPF TXT on the sending domain itself. Asking the provisioner keeps
   * that difference inside `carriers/` (CLAUDE.md) instead of in `domains.ts`.
   */
  mailFromFor(name: string): string;
  /** Register the identity with the provider. Idempotent: if it already exists, return its records. */
  createDomain(name: string, opts: { mailFromDomain: string }): Promise<{ records: DnsRecord[] }>;
  /**
   * Ask the provider for the current verification state and per-record status.
   *
   * Not read-only: a provisioner may also perform idempotent activation work
   * here, because the 5-minute poller is the only thing that ever notices a
   * domain has become verified. ACS uses it to drive verification forward one
   * step per sweep (it refuses SPF/DKIM until ownership is proven) and, once
   * all records pass, to register sender usernames and add the domain to the
   * Communication Service's `linkedDomains` — without which it cannot send.
   * Every such side effect must be safe to repeat on every sweep.
   */
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

/**
 * Azure Resource Manager credentials + resource coordinates, needed only to
 * provision sending domains. Sending and event ingest use the connection
 * string alone, so this block is optional: an ACS carrier configured before
 * domain provisioning existed keeps working as a "manual" carrier.
 */
export interface AcsArmConfig {
  /** Entra tenant of the service principal. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
  /** Email Communication Service resource that owns the domains. */
  emailServiceName: string;
  /** Communication Service resource the verified domain is linked to. */
  communicationServiceName: string;
  /**
   * Local parts registered as senders on every domain this carrier provisions.
   * ACS rejects a send from an unregistered username, and the failure only
   * shows up at send time, so a project sending as `support@` must have it
   * listed. Omit to get the `noreply`/`donotreply` defaults. Entries may be a
   * bare string or `{ username, displayName }`.
   */
  senderUsernames?: (string | { username: string; displayName?: string })[];
}

/** Decrypted per-carrier configuration shapes (stored AES-256-GCM in Carrier.configEnc). */
export interface AcsConfig {
  type: "acs";
  connectionString: string;
  /** ACS resource id, asserted against Event Grid `topic` on ingest. */
  resourceId: string;
  /** Present only on carriers allowed to provision domains via ARM. */
  arm?: AcsArmConfig;
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
