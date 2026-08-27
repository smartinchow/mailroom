import type { EventType } from "@prisma/client";

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

export interface Carrier {
  readonly type: "acs" | "ses" | "smtp";
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  /** Handshake + authenticity. Returns a body to echo, or a verdict. */
  verifyHook(raw: RawRequest): Promise<HookVerdict>;
  parseEvents(payload: unknown): NormalizedEvent[];
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
