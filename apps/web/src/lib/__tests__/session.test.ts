import { describe, expect, it } from "vitest";
import {
  constantTimeStringEqual,
  createSessionToken,
  timingSafeEqualBytes,
  verifySessionToken,
} from "../session";

const SECRET = "test-secret-0123456789abcdef";

describe("session tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(SECRET, token)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken(SECRET);
    const [payload, sig] = token.split(".");
    const tampered = `${payload.slice(0, -2)}AA.${sig}`;
    expect(await verifySessionToken(SECRET, tampered)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken("some-other-secret");
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const token = await createSessionToken(SECRET, 1000, past);
    expect(await verifySessionToken(SECRET, token)).toBe(false);
  });

  it("rejects garbage", async () => {
    expect(await verifySessionToken(SECRET, "")).toBe(false);
    expect(await verifySessionToken(SECRET, "a.b.c")).toBe(false);
    expect(await verifySessionToken(SECRET, "!!!not-base64url!!!.sig")).toBe(false);
  });
});

describe("constant-time comparisons", () => {
  it("timingSafeEqualBytes compares correctly", () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("constantTimeStringEqual compares passwords of unequal length safely", async () => {
    expect(await constantTimeStringEqual("hunter2", "hunter2")).toBe(true);
    expect(await constantTimeStringEqual("hunter2", "hunter3")).toBe(false);
    expect(await constantTimeStringEqual("short", "much-longer-password")).toBe(false);
    expect(await constantTimeStringEqual("", "")).toBe(true);
  });
});
