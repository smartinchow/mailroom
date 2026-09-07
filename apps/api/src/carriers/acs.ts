import { EmailClient } from "@azure/communication-email";
import { bareAddress } from "../address.js";
import { safeEqual } from "../crypto.js";
import { createAcsDomainProvisioner } from "./acs-domains.js";
import type {
  AcsConfig,
  Carrier,
  HookVerdict,
  NormalizedEvent,
  OutboundMessage,
  RawRequest,
} from "./types.js";
import type { EventType } from "@prisma/client";

/**
 * ACS carrier. Facts that are easy to get wrong (see CLAUDE.md):
 * - beginSend's poller operation id IS the messageId Event Grid later reports.
 * - Event Grid delivers an unsigned JSON array; authenticate via URL secret +
 *   topic assertion, and echo validationCode for SubscriptionValidationEvent.
 * - Payloads carry no subject/body — content exists only because we stored it.
 */

const STATUS_MAP: Record<string, EventType | undefined> = {
  Delivered: "DELIVERED",
  Bounced: "BOUNCED",
  Suppressed: "SUPPRESSED",
  Quarantined: "SPAM",
  FilteredSpam: "SPAM",
  Failed: "FAILED",
  // Expanded: log only — no normalized event.
};

const HARD_SUPPRESS: ReadonlySet<EventType> = new Set(["BOUNCED"] as EventType[]);

export function createAcsCarrier(config: AcsConfig): Carrier {
  const client = new EmailClient(config.connectionString);

  return {
    type: "acs",

    // Provisioning needs ARM credentials the connection string does not carry.
    // Without them the carrier stays "manual": domains land VERIFIED at
    // creation, exactly as before this capability existed.
    domains: config.arm ? createAcsDomainProvisioner(config.arm) : undefined,

    async send(msg: OutboundMessage) {
      // ACS senderAddress must be a bare address; the display name comes from
      // the sender-username configuration on the ACS domain, not the payload.
      const sender = bareAddress(msg.from);
      if (!sender) throw new Error(`unparseable from address: ${msg.from}`);
      const poller = await client.beginSend({
        senderAddress: sender,
        recipients: {
          to: msg.to.map((address) => ({ address })),
          cc: msg.cc.map((address) => ({ address })),
          bcc: msg.bcc.map((address) => ({ address })),
        },
        content: msg.html
          ? { subject: msg.subject, html: msg.html, plainText: msg.text }
          : { subject: msg.subject, plainText: msg.text ?? "" },
        replyTo: msg.replyTo ? [{ address: msg.replyTo }] : undefined,
        headers: Object.keys(msg.headers).length ? msg.headers : undefined,
        attachments: msg.attachments.length
          ? msg.attachments.map((a) => ({
              name: a.filename,
              contentType: a.contentType,
              contentInBase64: a.content,
            }))
          : undefined,
      });
      // The operation id (== Event Grid data.messageId) is only exposed by the
      // SDK once the LRO reaches a terminal state, so wait for it. At ACS
      // quota scale (~100/hour) the blocked worker slot is irrelevant.
      const result = await poller.pollUntilDone();
      if (!result.id) throw new Error("ACS send returned no operation id");
      if (result.status && String(result.status).toLowerCase() !== "succeeded") {
        const err = result.error as { message?: string } | undefined;
        throw new Error(`ACS send ${result.status}: ${err?.message ?? "unknown error"}`);
      }
      return { providerMessageId: result.id };
    },

    async verifyHook(raw: RawRequest): Promise<HookVerdict> {
      const events = Array.isArray(raw.body) ? raw.body : [raw.body];
      const validation = events.find(
        (e: any) => e?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent",
      ) as any;
      if (validation) {
        return { ok: true, respondWith: { validationResponse: validation.data?.validationCode } };
      }
      for (const e of events as any[]) {
        const topic: string | undefined = e?.topic;
        if (!topic || !safeEqual(topic.toLowerCase(), config.resourceId.toLowerCase())) {
          return { ok: false, reason: "topic mismatch" };
        }
      }
      return { ok: true };
    },

    parseEvents(payload: unknown): NormalizedEvent[] {
      const events = Array.isArray(payload) ? payload : [payload];
      const out: NormalizedEvent[] = [];
      for (const e of events as any[]) {
        const eventType: string | undefined = e?.eventType;
        const data = e?.data ?? {};
        if (eventType === "Microsoft.Communication.EmailDeliveryReportReceived") {
          const type = STATUS_MAP[data.status as string];
          if (!type) continue; // Expanded and unknown statuses: log only
          out.push({
            providerMessageId: String(data.messageId ?? ""),
            type,
            recipient: data.recipient ? String(data.recipient) : undefined,
            occurredAt: new Date(
              data.deliveryAttemptTimeStamp ?? e.eventTime ?? Date.now(),
            ),
            providerRaw: e,
            suppress:
              type === "BOUNCED" && HARD_SUPPRESS.has(type)
                ? { reason: "HARD_BOUNCE" }
                : undefined,
            detail:
              data.deliveryStatusDetails?.statusMessage != null
                ? String(data.deliveryStatusDetails.statusMessage)
                : undefined,
          });
        } else if (eventType === "Microsoft.Communication.EmailEngagementTrackingReportReceived") {
          const engagement = String(data.engagementType ?? "").toLowerCase();
          const type: EventType | null =
            engagement === "view" ? "OPENED" : engagement === "click" ? "CLICKED" : null;
          if (!type) continue;
          out.push({
            providerMessageId: String(data.messageId ?? ""),
            type,
            recipient: data.recipient ? String(data.recipient) : undefined,
            occurredAt: new Date(data.userActionTimeStamp ?? e.eventTime ?? Date.now()),
            providerRaw: e,
            detail: data.engagementContext ? String(data.engagementContext) : undefined,
          });
        }
      }
      return out;
    },
  };
}
