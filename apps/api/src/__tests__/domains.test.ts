import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/mailroom_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MAILROOM_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.SESSION_SECRET ??= "test-session-secret-0000";
process.env.ADMIN_API_TOKEN ??= "test-admin-token-0000000";
process.env.HOOK_SECRET ??= "test-hook-secret-00000000";
process.env.LOG_LEVEL ??= "silent";

const mockPrisma = {
  domain: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  carrier: { findUnique: vi.fn() },
};
const mockCarrierFor = vi.fn();

vi.mock("../db.js", () => ({ prisma: mockPrisma }));
vi.mock("../carriers/index.js", () => ({ carrierFor: mockCarrierFor }));

const {
  VERIFICATION_WINDOW_MS,
  EXPIRED_MESSAGE,
  applyExpiry,
  normalizeDomainName,
  toPublicDomain,
  verifyPendingDomains,
} = await import("../domains.js");

// ---------------------------------------------------------------------------
// normalizeDomainName
// ---------------------------------------------------------------------------

describe("normalizeDomainName", () => {
  const accepted: [string, string][] = [
    ["example.com", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["example.com.", "example.com"],
    ["mail.amlify.au", "mail.amlify.au"],
    ["a-b.co.uk", "a-b.co.uk"],
    ["tx.amlify.au.", "tx.amlify.au"],
  ];
  it.each(accepted)("accepts %j → %j", (input, expected) => {
    expect(normalizeDomainName(input)).toBe(expected);
  });

  const rejected = [
    ["empty", ""],
    ["single label", "localhost"],
    ["scheme", "https://example.com"],
    ["address", "user@example.com"],
    ["wildcard", "*.example.com"],
    ["path", "example.com/mail"],
    ["whitespace", "exam ple.com"],
    ["leading dot", ".example.com"],
    ["double dot", "example..com"],
    ["leading hyphen label", "-bad.example.com"],
    ["trailing hyphen label", "bad-.example.com"],
    ["underscore", "_dmarc.example.com"],
    ["numeric tld", "example.123"],
    ["one-char tld", "example.c"],
    ["over-long label", `${"a".repeat(64)}.com`],
    ["not a string", 42 as unknown as string],
  ] as const;
  it.each(rejected)("rejects %s", (_label, input) => {
    expect(() => normalizeDomainName(input)).toThrowError(
      expect.objectContaining({ code: "invalid_domain", status: 400 }),
    );
  });
});

// ---------------------------------------------------------------------------
// 72h expiry
// ---------------------------------------------------------------------------

describe("applyExpiry (72h verification window)", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const fresh = new Date(now.getTime() - 3600 * 1000);
  const stale = new Date(now.getTime() - VERIFICATION_WINDOW_MS - 1000);
  const exactlyAtWindow = new Date(now.getTime() - VERIFICATION_WINDOW_MS);

  it("leaves a fresh PENDING domain alone", () => {
    expect(applyExpiry("PENDING", fresh, null, now)).toEqual({ status: "PENDING", error: null });
  });

  it("fails a PENDING domain older than 72h", () => {
    expect(applyExpiry("PENDING", stale, null, now)).toEqual({
      status: "FAILED",
      error: EXPIRED_MESSAGE,
    });
  });

  it("fails a TEMPORARY_FAILURE domain older than 72h", () => {
    expect(applyExpiry("TEMPORARY_FAILURE", stale, "transient", now)).toEqual({
      status: "FAILED",
      error: EXPIRED_MESSAGE,
    });
  });

  it("does not expire exactly on the boundary", () => {
    expect(applyExpiry("PENDING", exactlyAtWindow, null, now).status).toBe("PENDING");
  });

  it("never expires a domain that just verified, however old the row", () => {
    expect(applyExpiry("VERIFIED", stale, null, now)).toEqual({ status: "VERIFIED", error: null });
  });

  it("leaves an already FAILED domain's provider reason intact", () => {
    expect(applyExpiry("FAILED", stale, "DKIM verification failed", now)).toEqual({
      status: "FAILED",
      error: "DKIM verification failed",
    });
  });
});

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

describe("toPublicDomain", () => {
  const row = {
    id: "dom_1",
    name: "example.com",
    projectId: "proj_1",
    carrierId: "car_1",
    fallbackCarrierId: null,
    verifiedAt: null,
    notes: null,
    status: "PENDING" as const,
    dnsRecords: [
      {
        type: "CNAME",
        name: "tok1._domainkey.example.com",
        value: "tok1.dkim.amazonses.com",
        ttl: 300,
        purpose: "DKIM",
        required: true,
        status: "PENDING",
      },
      {
        type: "MX",
        name: "send.example.com",
        value: "feedback-smtp.ap-southeast-2.amazonses.com",
        priority: 10,
        ttl: 300,
        purpose: "MAIL_FROM_MX",
        required: true,
        status: "VERIFIED",
      },
    ] as never,
    mailFromDomain: "send.example.com",
    lastCheckedAt: null,
    verificationError: null,
    createdAt: new Date("2026-09-04T00:00:00.000Z"),
    carrier: { id: "car_1", name: "ses-mailroom", type: "SES" as const },
  };

  it("is snake_case with lower-cased enums and null-filled optionals", () => {
    expect(toPublicDomain(row)).toEqual({
      id: "dom_1",
      name: "example.com",
      status: "pending",
      carrier: { id: "car_1", name: "ses-mailroom", type: "SES" },
      project_id: "proj_1",
      mail_from_domain: "send.example.com",
      records: [
        {
          type: "CNAME",
          name: "tok1._domainkey.example.com",
          value: "tok1.dkim.amazonses.com",
          priority: null,
          ttl: 300,
          purpose: "dkim",
          required: true,
          status: "pending",
        },
        {
          type: "MX",
          name: "send.example.com",
          value: "feedback-smtp.ap-southeast-2.amazonses.com",
          priority: 10,
          ttl: 300,
          purpose: "mail_from_mx",
          required: true,
          status: "verified",
        },
      ],
      verified_at: null,
      last_checked_at: null,
      verification_error: null,
      created_at: new Date("2026-09-04T00:00:00.000Z"),
    });
  });

  it("lower-cases temporary_failure and copes with an empty record set", () => {
    const manual = { ...row, status: "TEMPORARY_FAILURE" as const, dnsRecords: [] as never };
    const out = toPublicDomain(manual);
    expect(out.status).toBe("temporary_failure");
    expect(out.records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Poller resilience
// ---------------------------------------------------------------------------

describe("verifyPendingDomains", () => {
  const CARRIER_ROW = { id: "car_1", name: "ses-mailroom" };

  function pendingRow(id: string, name: string) {
    return {
      id,
      name,
      projectId: "proj_1",
      carrierId: CARRIER_ROW.id,
      fallbackCarrierId: null,
      verifiedAt: null,
      notes: null,
      status: "PENDING" as const,
      dnsRecords: [],
      mailFromDomain: null,
      lastCheckedAt: null,
      verificationError: null,
      createdAt: new Date(),
      carrier: { id: CARRIER_ROW.id, name: CARRIER_ROW.name, type: "SES" as const },
    };
  }

  it("keeps checking the remaining domains after one domain's checkDomain throws", async () => {
    const domainA = pendingRow("dom_a", "a.example.com");
    const domainB = pendingRow("dom_b", "b.example.com");

    mockPrisma.domain.findMany.mockResolvedValue([
      { id: domainA.id, name: domainA.name },
      { id: domainB.id, name: domainB.name },
    ]);
    mockPrisma.domain.findUnique.mockResolvedValueOnce(domainA).mockResolvedValueOnce(domainB);
    mockPrisma.carrier.findUnique.mockResolvedValue(CARRIER_ROW);

    const checkDomain = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unreachable"))
      .mockResolvedValueOnce({ status: "VERIFIED", records: [] });
    mockCarrierFor.mockReturnValue({ domains: { checkDomain } });
    mockPrisma.domain.update.mockResolvedValue({ ...domainB, status: "VERIFIED" });

    const result = await verifyPendingDomains();

    // Both domains were attempted — the first's failure never aborted the batch.
    expect(checkDomain).toHaveBeenCalledTimes(2);
    expect(checkDomain).toHaveBeenNthCalledWith(1, "a.example.com", { mailFromDomain: "send.a.example.com" });
    expect(checkDomain).toHaveBeenNthCalledWith(2, "b.example.com", { mailFromDomain: "send.b.example.com" });
    expect(result).toEqual({ checked: 1, verified: 1, failed: 0 });
  });
});
