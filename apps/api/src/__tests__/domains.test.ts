import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/mailroom_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MAILROOM_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.SESSION_SECRET ??= "test-session-secret-0000";
process.env.ADMIN_API_TOKEN ??= "test-admin-token-0000000";
process.env.HOOK_SECRET ??= "test-hook-secret-00000000";
process.env.LOG_LEVEL ??= "silent";

const mockPrisma = {
  domain: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  carrier: { findUnique: vi.fn(), findFirst: vi.fn() },
  message: { count: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
};
const mockCarrierFor = vi.fn();

vi.mock("../db.js", () => ({ prisma: mockPrisma }));
vi.mock("../carriers/index.js", () => ({ carrierFor: mockCarrierFor }));

const {
  VERIFICATION_WINDOW_MS,
  EXPIRED_MESSAGE,
  applyExpiry,
  normalizeDomainName,
  reprovisionDomain,
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
          note: null,
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
          note: null,
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
    mockCarrierFor.mockReturnValue({
      domains: { checkDomain, mailFromFor: (name: string) => `send.${name}` },
    });
    mockPrisma.domain.update.mockResolvedValue({ ...domainB, status: "VERIFIED" });

    const result = await verifyPendingDomains();

    // Both domains were attempted — the first's failure never aborted the batch.
    expect(checkDomain).toHaveBeenCalledTimes(2);
    expect(checkDomain).toHaveBeenNthCalledWith(1, "a.example.com", { mailFromDomain: "send.a.example.com" });
    expect(checkDomain).toHaveBeenNthCalledWith(2, "b.example.com", { mailFromDomain: "send.b.example.com" });
    expect(result).toEqual({ checked: 1, verified: 1, failed: 0 });
  });
});


// ---------------------------------------------------------------------------
// Reprovision (moving a live domain between carriers)
// ---------------------------------------------------------------------------

describe("reprovisionDomain", () => {
  const SMTP_ROW = { id: "car_smtp", name: "cpanel-smtp", enabled: true };
  const SES_ROW = { id: "car_ses", name: "ses-mailroom", enabled: true };
  const ACS_ROW = { id: "car_acs", name: "acs-mailroom", enabled: true };

  const ACS_RECORDS = [
    {
      type: "TXT",
      name: "tintinpos.com",
      value: "ms-domain-verification=abc",
      purpose: "DOMAIN_OWNERSHIP",
      required: true,
      status: "PENDING",
    },
  ];

  /** The domain as it exists today: live on the cPanel SMTP carrier. */
  function smtpDomain(overrides: Record<string, unknown> = {}) {
    return {
      id: "dom_tintin",
      name: "tintinpos.com",
      projectId: "proj_1",
      carrierId: SMTP_ROW.id,
      fallbackCarrierId: null,
      verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      notes: null,
      status: "VERIFIED" as const,
      dnsRecords: [],
      mailFromDomain: null,
      lastCheckedAt: null,
      verificationError: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      carrier: { id: SMTP_ROW.id, name: SMTP_ROW.name, type: "SMTP" as const },
      ...overrides,
    };
  }

  const acsProvisioner = {
    mailFromFor: (name: string) => name,
    createDomain: vi.fn(),
    checkDomain: vi.fn(),
    deleteDomain: vi.fn(),
  };
  const sesProvisioner = {
    mailFromFor: (name: string) => `send.${name}`,
    createDomain: vi.fn(),
    checkDomain: vi.fn(),
    deleteDomain: vi.fn(),
  };

  /** Carrier rows keyed by id, so both the target and the old carrier resolve. */
  function carriers(rows: { id: string }[]) {
    mockPrisma.carrier.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
    );
  }

  /** SMTP is manual; SES and ACS provision. */
  function adapters() {
    mockCarrierFor.mockImplementation((row: { id: string }) => {
      if (row.id === ACS_ROW.id) return { type: "acs", domains: acsProvisioner };
      if (row.id === SES_ROW.id) return { type: "ses", domains: sesProvisioner };
      return { type: "smtp" };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    acsProvisioner.createDomain.mockResolvedValue({ records: ACS_RECORDS });
    acsProvisioner.deleteDomain.mockResolvedValue(undefined);
    sesProvisioner.createDomain.mockResolvedValue({ records: [] });
    sesProvisioner.deleteDomain.mockResolvedValue(undefined);
    mockPrisma.domain.findUnique.mockResolvedValue(smtpDomain());
    mockPrisma.domain.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      smtpDomain(data),
    );
    adapters();
    carriers([SMTP_ROW, SES_ROW, ACS_ROW]);
  });

  it("registers at the target carrier and lands PENDING with fresh records", async () => {
    const out = await reprovisionDomain("dom_tintin", ACS_ROW.id);

    expect(acsProvisioner.createDomain).toHaveBeenCalledWith("tintinpos.com", {
      mailFromDomain: "tintinpos.com",
    });
    const { data } = mockPrisma.domain.update.mock.calls[0][0];
    expect(data.carrierId).toBe(ACS_ROW.id);
    expect(data.status).toBe("PENDING");
    expect(data.dnsRecords).toEqual(ACS_RECORDS);
    expect(data.mailFromDomain).toBe("tintinpos.com");
    expect(data.verifiedAt).toBeNull();
    expect(data.verificationError).toBeNull();
    // The 72h window restarts from the move, not from the 2026-01-01 row.
    expect(data.createdAt).toBeInstanceOf(Date);
    expect((data.createdAt as Date).getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00.000Z").getTime(),
    );
    expect(out.status).toBe("PENDING");
  });

  it("moves onto a manual carrier as VERIFIED with no records", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue(
      smtpDomain({
        carrierId: ACS_ROW.id,
        status: "PENDING",
        dnsRecords: ACS_RECORDS,
        mailFromDomain: "tintinpos.com",
        carrier: { id: ACS_ROW.id, name: ACS_ROW.name, type: "ACS" },
      }),
    );

    await reprovisionDomain("dom_tintin", SMTP_ROW.id);

    const { data } = mockPrisma.domain.update.mock.calls[0][0];
    expect(data.carrierId).toBe(SMTP_ROW.id);
    expect(data.status).toBe("VERIFIED");
    expect(data.dnsRecords).toEqual([]);
    expect(data.mailFromDomain).toBeNull();
    expect(data.verifiedAt).toBeInstanceOf(Date);
    // Nothing to verify upstream, so there is no 72h window to restart.
    expect(data.createdAt).toBeUndefined();
  });

  it("leaves the row untouched when the target carrier refuses", async () => {
    acsProvisioner.createDomain.mockRejectedValue(new Error("ARM 403 AuthorizationFailed"));

    await expect(reprovisionDomain("dom_tintin", ACS_ROW.id)).rejects.toMatchObject({
      status: 502,
      code: "provider_error",
      extra: { message: "ARM 403 AuthorizationFailed" },
    });

    // The assertion that matters: the carrier did not move, so the domain
    // keeps sending on SMTP exactly as it did before the attempt.
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
    expect(acsProvisioner.deleteDomain).not.toHaveBeenCalled();
  });

  it("is a no-op when the domain is already on the target carrier", async () => {
    const out = await reprovisionDomain("dom_tintin", SMTP_ROW.id);

    expect(out.carrierId).toBe(SMTP_ROW.id);
    expect(out.status).toBe("VERIFIED");
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
    expect(acsProvisioner.createDomain).not.toHaveBeenCalled();
    expect(sesProvisioner.deleteDomain).not.toHaveBeenCalled();
  });

  it("deprovisions at the old carrier only after the move is committed", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue(
      smtpDomain({ carrierId: SES_ROW.id, carrier: { id: SES_ROW.id, name: SES_ROW.name, type: "SES" } }),
    );

    await reprovisionDomain("dom_tintin", ACS_ROW.id);

    expect(sesProvisioner.deleteDomain).toHaveBeenCalledWith("tintinpos.com");
    expect(sesProvisioner.deleteDomain.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockPrisma.domain.update.mock.invocationCallOrder[0],
    );
  });

  it("keeps the move when the old carrier refuses to deprovision", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue(
      smtpDomain({ carrierId: SES_ROW.id, carrier: { id: SES_ROW.id, name: SES_ROW.name, type: "SES" } }),
    );
    sesProvisioner.deleteDomain.mockRejectedValue(new Error("Throttling"));

    const out = await reprovisionDomain("dom_tintin", ACS_ROW.id);

    expect(out.status).toBe("PENDING");
    expect(out.carrierId).toBe(ACS_ROW.id);
    // One update, never rolled back.
    expect(mockPrisma.domain.update).toHaveBeenCalledTimes(1);
  });

  it("never touches the message log", async () => {
    await reprovisionDomain("dom_tintin", ACS_ROW.id);

    expect(mockPrisma.message.update).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.deleteMany).not.toHaveBeenCalled();
    // The row keeps its id, so every Message.domainId stays valid.
    expect(mockPrisma.domain.update.mock.calls[0][0].where).toEqual({ id: "dom_tintin" });
  });

  it("404s an unknown domain and an unknown carrier, provisioning neither", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    await expect(reprovisionDomain("dom_missing", ACS_ROW.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });

    mockPrisma.domain.findUnique.mockResolvedValue(smtpDomain());
    await expect(reprovisionDomain("dom_tintin", "car_nope")).rejects.toMatchObject({
      status: 404,
      code: "carrier_not_found",
    });

    expect(acsProvisioner.createDomain).not.toHaveBeenCalled();
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
  });

  it("refuses a disabled target carrier the way an unset default is refused", async () => {
    carriers([SMTP_ROW, { ...ACS_ROW, enabled: false }]);

    await expect(reprovisionDomain("dom_tintin", ACS_ROW.id)).rejects.toMatchObject({
      status: 409,
      code: "no_default_carrier",
    });
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
  });
});
