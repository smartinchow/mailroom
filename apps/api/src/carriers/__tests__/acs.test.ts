import { beforeEach, describe, expect, it } from "vitest";
import { createAcsCarrier } from "../acs.js";
import type { Carrier } from "../types.js";

const RESOURCE_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-x/providers/Microsoft.Communication/CommunicationServices/test-acs";

function deliveryEvent(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    topic: RESOURCE_ID,
    subject: "sender/noreply@tx.example.com/message/1111-2222",
    eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
    eventTime: "2026-08-15T10:00:05Z",
    dataVersion: "1.0",
    data: {
      sender: "noreply@tx.example.com",
      recipient: "user@example.org",
      messageId: "1111-2222",
      status,
      deliveryStatusDetails: { statusMessage: `carrier said ${status}` },
      deliveryAttemptTimeStamp: "2026-08-15T10:00:04.9Z",
      ...overrides,
    },
  };
}

describe("acs carrier", () => {
  let carrier: Carrier;

  beforeEach(() => {
    process.env.MAILROOM_ENCRYPTION_KEY ??= "0".repeat(64);
    carrier = createAcsCarrier({
      type: "acs",
      connectionString: "endpoint=https://test.communication.azure.com/;accesskey=Zm9v",
      resourceId: RESOURCE_ID,
    });
  });

  describe("verifyHook", () => {
    it("echoes the validation code for SubscriptionValidationEvent", async () => {
      const verdict = await carrier.verifyHook({
        headers: {},
        body: [
          {
            eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
            data: { validationCode: "CODE-123" },
          },
        ],
      });
      expect(verdict).toEqual({ ok: true, respondWith: { validationResponse: "CODE-123" } });
    });

    it("accepts events whose topic matches the configured resource id (case-insensitive)", async () => {
      const verdict = await carrier.verifyHook({
        headers: {},
        body: [deliveryEvent("Delivered")],
      });
      expect(verdict.ok).toBe(true);
    });

    it("rejects a topic mismatch", async () => {
      const evt = { ...deliveryEvent("Delivered"), topic: RESOURCE_ID.replace("test-acs", "evil") };
      const verdict = await carrier.verifyHook({ headers: {}, body: [evt] });
      expect(verdict.ok).toBe(false);
    });

    it("rejects a missing topic", async () => {
      const { topic: _drop, ...evt } = deliveryEvent("Delivered");
      const verdict = await carrier.verifyHook({ headers: {}, body: [evt] });
      expect(verdict.ok).toBe(false);
    });
  });

  describe("parseEvents", () => {
    it.each([
      ["Delivered", "DELIVERED"],
      ["Bounced", "BOUNCED"],
      ["Suppressed", "SUPPRESSED"],
      ["Quarantined", "SPAM"],
      ["FilteredSpam", "SPAM"],
      ["Failed", "FAILED"],
    ])("maps %s -> %s", (acsStatus, expected) => {
      const events = carrier.parseEvents([deliveryEvent(acsStatus)]);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(expected);
      expect(events[0].providerMessageId).toBe("1111-2222");
      expect(events[0].recipient).toBe("user@example.org");
      expect(events[0].occurredAt.toISOString()).toBe("2026-08-15T10:00:04.900Z");
      expect(events[0].detail).toBe(`carrier said ${acsStatus}`);
    });

    it("suppresses on hard bounce only", () => {
      expect(carrier.parseEvents([deliveryEvent("Bounced")])[0].suppress).toEqual({
        reason: "HARD_BOUNCE",
      });
      expect(carrier.parseEvents([deliveryEvent("Delivered")])[0].suppress).toBeUndefined();
    });

    it("drops Expanded (log-only) and unknown statuses", () => {
      expect(carrier.parseEvents([deliveryEvent("Expanded")])).toHaveLength(0);
      expect(carrier.parseEvents([deliveryEvent("SomethingNew")])).toHaveLength(0);
    });

    it("maps engagement events to OPENED / CLICKED", () => {
      const base = {
        id: "evt-2",
        topic: RESOURCE_ID,
        eventType: "Microsoft.Communication.EmailEngagementTrackingReportReceived",
        eventTime: "2026-08-15T11:00:00Z",
        data: {
          messageId: "1111-2222",
          recipient: "user@example.org",
          userActionTimeStamp: "2026-08-15T10:59:59Z",
          engagementContext: "https://example.com/clicked-link",
          engagementType: "click",
        },
      };
      const clicked = carrier.parseEvents([base]);
      expect(clicked[0].type).toBe("CLICKED");
      expect(clicked[0].detail).toBe("https://example.com/clicked-link");

      const viewed = carrier.parseEvents([{ ...base, data: { ...base.data, engagementType: "view" } }]);
      expect(viewed[0].type).toBe("OPENED");
    });

    it("ignores unrelated event types", () => {
      expect(
        carrier.parseEvents([{ eventType: "Microsoft.Storage.BlobCreated", data: {} }]),
      ).toHaveLength(0);
    });
  });
});
