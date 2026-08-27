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
}

export interface Domain {
  id: string;
  name: string;
  projectId: string | null;
  projectSlug: string | null;
  carrierId: string;
  carrierName: string;
  fallbackCarrierId: string | null;
  verifiedAt: string | null;
  notes: string | null;
}

export interface HookUrls {
  acs: string;
  ses: string;
}
