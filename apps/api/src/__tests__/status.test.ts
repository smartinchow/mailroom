import { describe, expect, it } from "vitest";
import { advanceStatus } from "../status.js";

const t0 = new Date("2026-08-01T00:00:00Z");
const t1 = new Date("2026-08-01T00:01:00Z");
const t2 = new Date("2026-08-01T00:02:00Z");

describe("advanceStatus", () => {
  it("advances SENT -> DELIVERED", () => {
    expect(advanceStatus("SENT", t0, "DELIVERED", t1).next).toBe("DELIVERED");
  });

  it("never regresses a terminal status", () => {
    expect(advanceStatus("DELIVERED", t1, "BOUNCED", t2).next).toBeNull();
    expect(advanceStatus("BOUNCED", t1, "DELIVERED", t2).next).toBeNull();
    expect(advanceStatus("FAILED", t1, "SENT", t2).next).toBeNull();
  });

  it("allows DELIVERED -> COMPLAINED (the one informative terminal move)", () => {
    expect(advanceStatus("DELIVERED", t1, "COMPLAINED", t2).next).toBe("COMPLAINED");
    expect(advanceStatus("DELIVERED", t2, "COMPLAINED", t1).next).toBeNull();
  });

  it("ignores stale events (occurredAt <= lastEventAt)", () => {
    expect(advanceStatus("SENT", t2, "DELIVERED", t1).next).toBeNull();
    expect(advanceStatus("SENT", t1, "DELIVERED", t1).next).toBeNull();
  });

  it("does not move backwards on late earlier-stage events", () => {
    expect(advanceStatus("SENT", t0, "SENDING", t1).next).toBeNull();
  });

  it("OPENED / CLICKED / DELAYED never change status", () => {
    expect(advanceStatus("SENT", t0, "OPENED", t1).next).toBeNull();
    expect(advanceStatus("DELIVERED", t0, "CLICKED", t1).next).toBeNull();
    expect(advanceStatus("SENT", t0, "DELAYED", t1).next).toBeNull();
  });

  it("first event with null lastEventAt applies", () => {
    expect(advanceStatus("QUEUED", null, "SENT", t0).next).toBe("SENT");
  });
});
