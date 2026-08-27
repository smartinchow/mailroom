import type { EventType, MessageStatus } from "@prisma/client";

/**
 * Status machine (design §5). Provider events duplicate and arrive out of
 * order: apply an event only if occurredAt is newer than lastEventAt, and
 * never regress a terminal status. OPENED / CLICKED are events, not statuses.
 */

export const TERMINAL: ReadonlySet<MessageStatus> = new Set([
  "DELIVERED",
  "BOUNCED",
  "SUPPRESSED",
  "SPAM",
  "COMPLAINED",
  "FAILED",
] as MessageStatus[]);

const EVENT_TO_STATUS: Partial<Record<EventType, MessageStatus>> = {
  QUEUED: "QUEUED",
  SENDING: "SENDING",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  BOUNCED: "BOUNCED",
  SUPPRESSED: "SUPPRESSED",
  COMPLAINED: "COMPLAINED",
  SPAM: "SPAM",
  FAILED: "FAILED",
  // DELAYED, OPENED, CLICKED never move the status.
};

const ORDER: Record<MessageStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  BOUNCED: 3,
  SUPPRESSED: 3,
  SPAM: 3,
  COMPLAINED: 3,
  FAILED: 3,
};

export interface StatusAdvance {
  next: MessageStatus | null;
  isNewer: boolean;
}

export function advanceStatus(
  current: MessageStatus,
  lastEventAt: Date | null,
  eventType: EventType,
  occurredAt: Date,
): StatusAdvance {
  const isNewer = lastEventAt == null || occurredAt.getTime() > lastEventAt.getTime();
  const candidate = EVENT_TO_STATUS[eventType];
  if (!candidate) return { next: null, isNewer };
  if (TERMINAL.has(current)) {
    // COMPLAINED may follow DELIVERED — the one terminal-to-terminal move that
    // carries new information. Everything else stays put.
    if (current === "DELIVERED" && candidate === "COMPLAINED" && isNewer) {
      return { next: "COMPLAINED", isNewer };
    }
    return { next: null, isNewer };
  }
  if (!isNewer) return { next: null, isNewer };
  if (ORDER[candidate] <= ORDER[current] && candidate !== current) {
    // Late-arriving earlier-stage event: record it, don't move backwards.
    return { next: null, isNewer };
  }
  return { next: candidate === current ? null : candidate, isNewer };
}
