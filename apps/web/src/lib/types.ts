/** Shapes of the admin API contract (GET /v1/admin/*). */

export type MessageStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "BOUNCED"
  | "SUPPRESSED"
  | "SPAM"
  | "COMPLAINED"
  | "FAILED";

export type EventType =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "BOUNCED"
  | "SUPPRESSED"
  | "COMPLAINED"
  | "SPAM"
  | "DELAYED"
  | "FAILED"
  | "OPENED"
  | "CLICKED";

export type CarrierType = "ACS" | "SES" | "SMTP";

export interface Overview {
  last24h: Partial<Record<MessageStatus, number>>;
  queueDepth: number;
  carriers: {
    id: string;
    name: string;
    type: CarrierType;
    enabled: boolean;
    ratePerHour: number;
    lastSendAt: string | null;
    recentFailures: number;
  }[];
}

export interface MessageListItem {
  id: string;
  queuedAt: string;
  projectSlug: string;
  to: string[];
  subject: string;
  tags: Record<string, string>;
  carrierType: CarrierType;
  status: MessageStatus;
  redactedLinkCount: number;
}

export interface MessageList {
  items: MessageListItem[];
  nextCursor: string | null;
}

export interface MessageEvent {
  type: EventType;
  recipient: string | null;
  occurredAt: string;
  providerRaw: unknown;
  receivedAt: string;
}

export interface MessageDetailRow {
  id: string;
  projectId: string;
  projectSlug?: string;
  domainId: string;
  carrierId: string;
  idempotencyKey: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  headers: Record<string, string>;
  tags: Record<string, string>;
  status: MessageStatus;
  providerMessageId: string | null;
  attempts: number;
  lastError: string | null;
  queuedAt: string;
  sentAt: string | null;
  lastEventAt: string | null;
}

export interface MessageDetail {
  message: MessageDetailRow;
  bodyHtml: string | null;
  bodyText: string | null;
  bodyPurgedAt: string | null;
  redactedLinkCount: number;
  events: MessageEvent[];
}

export interface Suppression {
  id: string;
  address: string;
  scope: string;
  reason: "HARD_BOUNCE" | "COMPLAINT" | "MANUAL";
  messageId: string | null;
  createdAt: string;
}

export interface SuppressionList {
  items: Suppression[];
  nextCursor: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  bodyRetention: "NONE" | "REDACTED" | "FULL";
  bodyRetentionDays: number;
  hourlyCap: number | null;
  createdAt: string;
  keyCount: number;
  domainCount: number;
}

export interface CreatedKey {
  plaintext: string;
  prefix: string;
  id: string;
}

export interface Carrier {
  id: string;
  name: string;
  type: CarrierType;
  enabled: boolean;
  ratePerSecond: number;
  ratePerHour: number;
  createdAt: string;
  isDefault: boolean;
}

/**
 * SES-only. 404 for other carrier types — callers must handle that. The provider can
 * report `null` for the send-limit fields (e.g. still provisioning) — render "—" for
 * those, never the literal string "null".
 */
export interface CarrierQuota {
  production_access: boolean;
  max_24h_send: number | null;
  max_send_rate: number | null;
  sent_last_24h: number | null;
}

export type DomainStatus = "pending" | "verified" | "failed" | "temporary_failure";

export type DnsRecordType = "CNAME" | "MX" | "TXT";
export type DnsRecordPurpose =
  | "dkim"
  | "mail_from_mx"
  | "mail_from_spf"
  | "dmarc"
  /** ACS domain-verification TXT; SES has no equivalent. */
  | "domain_ownership";
export type DnsRecordStatus = "pending" | "verified" | "failed" | "not_started";

export interface DnsRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  priority: number | null;
  ttl: number | null;
  purpose: DnsRecordPurpose;
  required: boolean;
  status: DnsRecordStatus;
  /** Set only when the carrier rewrote the value (e.g. an SPF record merged with one already published). */
  note?: string | null;
}

/**
 * One address the domain is allowed to send as. ACS registers each of these on
 * the domain and rejects a send from anything else — at send time, with no
 * earlier warning. `username` is stored as the operator typed it (a local part
 * or a full address); the carrier reduces it.
 */
export interface SenderUsername {
  username: string;
  displayName?: string;
}

/**
 * Wire shape from GET/POST /v1/admin/domains (spec docs/specs/domains.md §3, §5): the
 * spec-defined fields are snake_case, but the admin-only extras (projectSlug,
 * fallbackCarrierId, notes) are camelCase as shipped by the admin API — this mixed casing
 * is the fixed contract, not an inconsistency to "fix".
 */
export interface Domain {
  id: string;
  name: string;
  status: DomainStatus;
  carrier: { id: string; name: string; type: CarrierType };
  project_id: string | null;
  mail_from_domain: string | null;
  records: DnsRecord[];
  sender_usernames: SenderUsername[];
  verified_at: string | null;
  last_checked_at: string | null;
  verification_error: string | null;
  created_at: string;
  projectSlug: string | null;
  fallbackCarrierId: string | null;
  notes: string | null;
}

export interface HookUrls {
  acs: string;
  ses: string;
}
