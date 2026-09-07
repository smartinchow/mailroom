import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type Fastify from "fastify";
import type { DomainProvisioner } from "../../carriers/types.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/mailroom_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MAILROOM_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.SESSION_SECRET ??= "test-session-secret-0000";
process.env.ADMIN_API_TOKEN ??= "test-admin-token-0000000";
process.env.HOOK_SECRET ??= "test-hook-secret-00000000";
process.env.LOG_LEVEL ??= "silent";

const PROJECT = {
  id: "proj_1",
  name: "Amlify",
  slug: "amlify",
  bodyRetention: "REDACTED" as const,
  bodyRetentionDays: 90,
  hourlyCap: null,
  createdAt: new Date(),
};

const TOKEN = "mr_live_test1234_supersecretsupersecret";
const API_KEY_ROW = {
  id: "key_1",
  projectId: PROJECT.id,
  name: "app",
  prefix: "mr_live_test1234",
  keyHash: createHash("sha256").update(TOKEN).digest("hex"),
  lastUsedAt: null,
  revokedAt: null as Date | null,
  createdAt: new Date(),
  project: PROJECT,
};
const auth = { authorization: `Bearer ${TOKEN}` };

const SES_CARRIER_ROW = {
  id: "car_ses",
  type: "SES" as const,
  name: "ses-mailroom",
  configEnc: "v1.aa.bb.cc",
  enabled: true,
  isDefault: true,
  ratePerSecond: 1,
  ratePerHour: 100,
  createdAt: new Date(),
};

const RECORDS = [
  {
    type: "CNAME",
    name: "tok1._domainkey.mail.amlify.au",
    value: "tok1.dkim.amazonses.com",
    ttl: 300,
    purpose: "DKIM",
    required: true,
    status: "PENDING",
  },
];

function domainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dom_1",
    name: "mail.amlify.au",
    projectId: PROJECT.id,
    carrierId: SES_CARRIER_ROW.id,
    fallbackCarrierId: null,
    verifiedAt: null,
    notes: null,
    status: "PENDING",
    dnsRecords: RECORDS,
    mailFromDomain: "send.mail.amlify.au",
    lastCheckedAt: null,
    verificationError: null,
    createdAt: new Date("2026-09-04T00:00:00.000Z"),
    carrier: { id: SES_CARRIER_ROW.id, name: SES_CARRIER_ROW.name, type: SES_CARRIER_ROW.type },
    ...overrides,
  };
}

const mockPrisma = {
  apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  carrier: { findUnique: vi.fn(), findFirst: vi.fn() },
  domain: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  message: { count: vi.fn() },
};

const provisioner: DomainProvisioner = {
  mailFromFor: (name: string) => `send.${name}`,
  createDomain: vi.fn(async () => ({ records: RECORDS as never })),
  checkDomain: vi.fn(async () => ({ status: "VERIFIED" as const, records: RECORDS as never })),
  deleteDomain: vi.fn(async () => undefined),
};

const mockCarrierFor = vi.fn(() => ({ type: "ses", domains: provisioner }));

vi.mock("../../db.js", () => ({ prisma: mockPrisma }));
vi.mock("../../queue.js", () => ({
  enqueueSend: vi.fn(),
  sendQueue: { getJobCounts: vi.fn(async () => ({})) },
  maintenanceQueue: {},
  scheduleMaintenance: vi.fn(),
  SEND_QUEUE: "send",
  MAINTENANCE_QUEUE: "maintenance",
}));
vi.mock("../../carriers/index.js", () => ({
  carrierFor: (...args: unknown[]) => mockCarrierFor(...(args as [])),
  invalidateCarrierCache: vi.fn(),
}));

let app: Fastify.FastifyInstance;
/** The admin surface is a separate app: it authenticates by admin token, not API key. */
let adminApp: Fastify.FastifyInstance;
const adminAuth = { "x-admin-token": process.env.ADMIN_API_TOKEN as string };

beforeAll(async () => {
  const FastifyModule = (await import("fastify")).default;
  const { registerDomainRoutes } = await import("../domains.js");
  app = FastifyModule();
  registerDomainRoutes(app);
  await app.ready();

  const { registerAdminRoutes } = await import("../admin.js");
  adminApp = FastifyModule();
  registerAdminRoutes(adminApp);
  await adminApp.ready();
});

afterEach(() => {
  vi.clearAllMocks();
  mockPrisma.apiKey.update.mockResolvedValue({});
  mockPrisma.domain.count.mockResolvedValue(0);
  mockCarrierFor.mockReturnValue({ type: "ses", domains: provisioner });
  (provisioner.createDomain as ReturnType<typeof vi.fn>).mockResolvedValue({ records: RECORDS });
  (provisioner.checkDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "VERIFIED",
    records: RECORDS,
  });
  (provisioner.deleteDomain as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

function authed() {
  mockPrisma.apiKey.findUnique.mockResolvedValue(API_KEY_ROW);
}

// ---------------------------------------------------------------------------

describe("POST /v1/domains", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/domains", payload: { name: "example.com" } });
    expect(res.statusCode).toBe(401);
  });

  it("provisions on the default carrier and returns 201 with the wire shape", async () => {
    authed();
    mockPrisma.carrier.findFirst.mockResolvedValue(SES_CARRIER_ROW);
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    mockPrisma.domain.create.mockResolvedValue(domainRow());

    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "  Mail.Amlify.AU. " },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("mail.amlify.au");
    expect(body.status).toBe("pending");
    expect(body.mail_from_domain).toBe("send.mail.amlify.au");
    expect(body.records[0]).toMatchObject({ purpose: "dkim", status: "pending", priority: null });
    expect(body.carrier).toEqual({ id: "car_ses", name: "ses-mailroom", type: "SES" });

    expect(provisioner.createDomain).toHaveBeenCalledWith("mail.amlify.au", {
      mailFromDomain: "send.mail.amlify.au",
    });
    // The public route never lets the caller pick a carrier.
    expect(mockPrisma.carrier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDefault: true, enabled: true } }),
    );
    expect(mockPrisma.domain.create.mock.calls[0][0].data.projectId).toBe(PROJECT.id);
  });

  it("rejects an invalid domain name with 400 invalid_domain", async () => {
    authed();
    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "https://example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_domain");
    expect(mockPrisma.domain.create).not.toHaveBeenCalled();
  });

  it("returns 409 no_default_carrier when nothing is flagged default", async () => {
    authed();
    mockPrisma.carrier.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "example.com" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_default_carrier");
  });

  it("returns 409 domain_exists for a name already taken", async () => {
    authed();
    mockPrisma.carrier.findFirst.mockResolvedValue(SES_CARRIER_ROW);
    mockPrisma.domain.findUnique.mockResolvedValue({ id: "dom_other" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "mail.amlify.au" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "domain_exists", domain: "mail.amlify.au" });
    expect(provisioner.createDomain).not.toHaveBeenCalled();
  });

  it("returns 502 provider_error and creates no row when the provider refuses", async () => {
    authed();
    mockPrisma.carrier.findFirst.mockResolvedValue(SES_CARRIER_ROW);
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    (provisioner.createDomain as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("AccessDenied"));

    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "mail.amlify.au" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "provider_error", message: "AccessDenied" });
    expect(mockPrisma.domain.create).not.toHaveBeenCalled();
  });

  it("returns 409 domain_limit_reached at 20 domains for the project", async () => {
    authed();
    mockPrisma.carrier.findFirst.mockResolvedValue(SES_CARRIER_ROW);
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    mockPrisma.domain.count.mockResolvedValue(20);

    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "one-too-many.example.com" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "domain_limit_reached" });
    expect(mockPrisma.domain.count).toHaveBeenCalledWith({ where: { projectId: PROJECT.id } });
    expect(provisioner.createDomain).not.toHaveBeenCalled();
    expect(mockPrisma.domain.create).not.toHaveBeenCalled();
  });

  it("marks a manual (non-provisioning) carrier VERIFIED with no records", async () => {
    authed();
    mockPrisma.carrier.findFirst.mockResolvedValue({ ...SES_CARRIER_ROW, type: "SMTP" });
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    mockCarrierFor.mockReturnValue({ type: "smtp" } as never);
    mockPrisma.domain.create.mockImplementation(async (args: { data: Record<string, unknown> }) =>
      domainRow({ ...args.data, carrier: domainRow().carrier }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/domains",
      headers: auth,
      payload: { name: "legacy.example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("verified");
    expect(res.json().records).toEqual([]);
    expect(res.json().mail_from_domain).toBeNull();
  });
});

describe("GET /v1/domains", () => {
  it("lists only the key's own project domains, never shared ones", async () => {
    authed();
    mockPrisma.domain.findMany.mockResolvedValue([domainRow()]);
    const res = await app.inject({ method: "GET", url: "/v1/domains", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(mockPrisma.domain.findMany.mock.calls[0][0].where).toEqual({ projectId: PROJECT.id });
  });
});

describe("GET /v1/domains/:id", () => {
  it("404s a domain that belongs to another project", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/v1/domains/dom_x", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("returns the domain object for an owned domain", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue(domainRow());
    const res = await app.inject({ method: "GET", url: "/v1/domains/dom_1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("dom_1");
  });
});

describe("POST /v1/domains/:id/verify", () => {
  it("re-checks with the carrier and returns the updated domain", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue({ id: "dom_1" });
    mockPrisma.domain.findUnique.mockResolvedValue(domainRow());
    mockPrisma.carrier.findUnique.mockResolvedValue(SES_CARRIER_ROW);
    mockPrisma.domain.update.mockResolvedValue(
      domainRow({ status: "VERIFIED", verifiedAt: new Date(), lastCheckedAt: new Date() }),
    );

    const res = await app.inject({ method: "POST", url: "/v1/domains/dom_1/verify", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("verified");
    expect(provisioner.checkDomain).toHaveBeenCalledWith("mail.amlify.au", {
      mailFromDomain: "send.mail.amlify.au",
    });
    const update = mockPrisma.domain.update.mock.calls[0][0];
    expect(update.data.status).toBe("VERIFIED");
    expect(update.data.verificationError).toBeNull();
    expect(update.data.verifiedAt).toBeInstanceOf(Date);
  });

  it("404s a domain the key does not own, without calling the carrier", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue(null);
    const res = await app.inject({ method: "POST", url: "/v1/domains/dom_x/verify", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(provisioner.checkDomain).not.toHaveBeenCalled();
  });
});

describe("DELETE /v1/domains/:id", () => {
  it("deletes the provider identity and the row, returning 204", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue({ id: "dom_1" });
    mockPrisma.domain.findUnique.mockResolvedValue(domainRow());
    mockPrisma.message.count.mockResolvedValue(0);
    mockPrisma.carrier.findUnique.mockResolvedValue(SES_CARRIER_ROW);
    mockPrisma.domain.delete.mockResolvedValue(domainRow());

    const res = await app.inject({ method: "DELETE", url: "/v1/domains/dom_1", headers: auth });
    expect(res.statusCode).toBe(204);
    expect(provisioner.deleteDomain).toHaveBeenCalledWith("mail.amlify.au");
    expect(mockPrisma.domain.delete).toHaveBeenCalledWith({ where: { id: "dom_1" } });
  });

  it("returns 409 domain_in_use when messages reference the domain", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue({ id: "dom_1" });
    mockPrisma.domain.findUnique.mockResolvedValue(domainRow());
    mockPrisma.message.count.mockResolvedValue(3);

    const res = await app.inject({ method: "DELETE", url: "/v1/domains/dom_1", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "domain_in_use", messages: 3 });
    expect(mockPrisma.domain.delete).not.toHaveBeenCalled();
    expect(provisioner.deleteDomain).not.toHaveBeenCalled();
  });

  it("still removes the row when the provider delete fails", async () => {
    authed();
    mockPrisma.domain.findFirst.mockResolvedValue({ id: "dom_1" });
    mockPrisma.domain.findUnique.mockResolvedValue(domainRow());
    mockPrisma.message.count.mockResolvedValue(0);
    mockPrisma.carrier.findUnique.mockResolvedValue(SES_CARRIER_ROW);
    (provisioner.deleteDomain as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Throttling"));
    mockPrisma.domain.delete.mockResolvedValue(domainRow());

    const res = await app.inject({ method: "DELETE", url: "/v1/domains/dom_1", headers: auth });
    expect(res.statusCode).toBe(204);
    expect(mockPrisma.domain.delete).toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Admin-only: moving a domain to another carrier
// ---------------------------------------------------------------------------

describe("POST /v1/admin/domains/:id/reprovision", () => {
  const SMTP_CARRIER_ROW = { ...SES_CARRIER_ROW, id: "car_smtp", type: "SMTP" as const, name: "cpanel-smtp" };

  function smtpDomainRow(overrides: Record<string, unknown> = {}) {
    return domainRow({
      carrierId: SMTP_CARRIER_ROW.id,
      status: "VERIFIED",
      dnsRecords: [],
      mailFromDomain: null,
      verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      carrier: { id: SMTP_CARRIER_ROW.id, name: SMTP_CARRIER_ROW.name, type: "SMTP" },
      ...overrides,
    });
  }

  /** SMTP is manual, SES provisions — keyed by row so old and new both resolve. */
  function adapters() {
    mockCarrierFor.mockImplementation((row: { id: string }) =>
      row.id === SES_CARRIER_ROW.id ? { type: "ses", domains: provisioner } : ({ type: "smtp" } as never),
    );
    mockPrisma.carrier.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      [SES_CARRIER_ROW, SMTP_CARRIER_ROW].find((c) => c.id === where.id) ?? null,
    );
  }

  it("rejects a request without the admin token", async () => {
    const res = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/domains/dom_1/reprovision",
      payload: { carrierId: SES_CARRIER_ROW.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it("moves the domain onto the target carrier and returns the admin shape", async () => {
    adapters();
    mockPrisma.domain.findUnique.mockResolvedValue(smtpDomainRow());
    mockPrisma.domain.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      smtpDomainRow({ ...data, carrier: domainRow().carrier }),
    );
    mockPrisma.domain.findUniqueOrThrow.mockImplementation(async () =>
      domainRow({ status: "PENDING", project: { slug: "amlify" } }),
    );

    const res = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/domains/dom_1/reprovision",
      headers: adminAuth,
      payload: { carrierId: SES_CARRIER_ROW.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.projectSlug).toBe("amlify");
    expect(body.carrierId).toBe(SES_CARRIER_ROW.id);
    expect(provisioner.createDomain).toHaveBeenCalledWith("mail.amlify.au", {
      mailFromDomain: "send.mail.amlify.au",
    });
    expect(mockPrisma.domain.update.mock.calls[0][0].data.carrierId).toBe(SES_CARRIER_ROW.id);
  });

  it("400s a body with no carrierId, without touching the row", async () => {
    const res = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/domains/dom_1/reprovision",
      headers: adminAuth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
    expect(provisioner.createDomain).not.toHaveBeenCalled();
  });

  it("404s an unknown domain", async () => {
    adapters();
    mockPrisma.domain.findUnique.mockResolvedValue(null);

    const res = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/domains/dom_missing/reprovision",
      headers: adminAuth,
      payload: { carrierId: SES_CARRIER_ROW.id },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(provisioner.createDomain).not.toHaveBeenCalled();
  });

  it("502s and leaves the domain on its old carrier when the target refuses", async () => {
    adapters();
    mockPrisma.domain.findUnique.mockResolvedValue(smtpDomainRow());
    (provisioner.createDomain as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("AccessDenied"));

    const res = await adminApp.inject({
      method: "POST",
      url: "/v1/admin/domains/dom_1/reprovision",
      headers: adminAuth,
      payload: { carrierId: SES_CARRIER_ROW.id },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "provider_error", message: "AccessDenied" });
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
  });

  it("is not exposed on the public API", async () => {
    authed();
    const res = await app.inject({
      method: "POST",
      url: "/v1/domains/dom_1/reprovision",
      headers: auth,
      payload: { carrierId: SES_CARRIER_ROW.id },
    });
    expect(res.statusCode).toBe(404);
  });

  // The dashboard's carrier select posts to PATCH, not to this endpoint. A bare
  // FK write there would leave the domain VERIFIED but registered nowhere, so
  // PATCH must provision through the same service.
  it("PATCH with a new carrierId provisions rather than just moving the FK", async () => {
    adapters();
    mockPrisma.domain.findUnique.mockResolvedValue(smtpDomainRow());
    mockPrisma.domain.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      smtpDomainRow({ ...data, carrier: domainRow().carrier }),
    );

    const res = await adminApp.inject({
      method: "PATCH",
      url: "/v1/admin/domains/dom_1",
      headers: adminAuth,
      payload: { carrierId: SES_CARRIER_ROW.id, notes: "moved" },
    });

    expect(res.statusCode).toBe(200);
    expect(provisioner.createDomain).toHaveBeenCalledWith("mail.amlify.au", expect.anything());
  });

  it("PATCH refuses the move when the provider does, leaving the carrier put", async () => {
    adapters();
    mockPrisma.domain.findUnique.mockResolvedValue(smtpDomainRow());
    provisioner.createDomain.mockRejectedValueOnce(new Error("AccessDenied"));

    const res = await adminApp.inject({
      method: "PATCH",
      url: "/v1/admin/domains/dom_1",
      headers: adminAuth,
      payload: { carrierId: SES_CARRIER_ROW.id },
    });

    expect(res.statusCode).toBe(502);
    expect(mockPrisma.domain.update).not.toHaveBeenCalled();
  });
});
