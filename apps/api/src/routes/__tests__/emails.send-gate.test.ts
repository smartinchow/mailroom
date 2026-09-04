import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type Fastify from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/mailroom_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MAILROOM_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.SESSION_SECRET ??= "test-session-secret-0000";
process.env.ADMIN_API_TOKEN ??= "test-admin-token-0000000";
process.env.HOOK_SECRET ??= "test-hook-secret-00000000";
process.env.LOG_LEVEL ??= "silent";

/**
 * D-07 send gate: a key may only send from its project's domains, and only
 * once that domain is actually verified with the carrier.
 */

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

const CARRIER = {
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

function domain(status: string) {
  return {
    id: "dom_1",
    name: "mail.amlify.au",
    projectId: PROJECT.id,
    carrierId: CARRIER.id,
    fallbackCarrierId: null,
    verifiedAt: status === "VERIFIED" ? new Date() : null,
    notes: null,
    status,
    dnsRecords: [],
    mailFromDomain: "send.mail.amlify.au",
    lastCheckedAt: null,
    verificationError: null,
    createdAt: new Date(),
    carrier: CARRIER,
  };
}

const mockPrisma = {
  apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  domain: { findUnique: vi.fn() },
  suppression: { findFirst: vi.fn().mockResolvedValue(null) },
  message: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
};
const mockEnqueueSend = vi.fn().mockResolvedValue(undefined);

vi.mock("../../db.js", () => ({ prisma: mockPrisma }));
vi.mock("../../redis.js", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
  newRedis: vi.fn(),
}));
vi.mock("../../queue.js", () => ({
  enqueueSend: mockEnqueueSend,
  sendQueue: {},
  maintenanceQueue: {},
  scheduleMaintenance: vi.fn(),
  SEND_QUEUE: "send",
  MAINTENANCE_QUEUE: "maintenance",
  PURGE_BODIES_JOB: "purge-bodies",
  DOMAIN_VERIFY_JOB: "domain-verify",
}));

let app: Fastify.FastifyInstance;

beforeAll(async () => {
  const FastifyModule = (await import("fastify")).default;
  const { registerEmailRoutes } = await import("../emails.js");
  app = FastifyModule();
  registerEmailRoutes(app);
  await app.ready();
});

afterEach(() => {
  vi.clearAllMocks();
  mockPrisma.apiKey.update.mockResolvedValue({});
  mockPrisma.suppression.findFirst.mockResolvedValue(null);
  mockPrisma.message.findUnique.mockResolvedValue(null);
  mockPrisma.message.create.mockResolvedValue({});
  mockEnqueueSend.mockResolvedValue(undefined);
});

function send() {
  mockPrisma.apiKey.findUnique.mockResolvedValue(API_KEY_ROW);
  return app.inject({
    method: "POST",
    url: "/v1/emails",
    headers: auth,
    payload: {
      from: "Amlify <hello@mail.amlify.au>",
      to: "jane@example.com",
      subject: "Hello",
      text: "Hi",
    },
  });
}

describe("D-07 send gate: domain verification", () => {
  it.each(["PENDING", "FAILED", "TEMPORARY_FAILURE"])(
    "returns 403 domain_not_verified for a %s domain",
    async (status) => {
      mockPrisma.domain.findUnique.mockResolvedValue(domain(status));
      const res = await send();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: "domain_not_verified",
        domain: "mail.amlify.au",
        status: status.toLowerCase(),
      });
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
      expect(mockEnqueueSend).not.toHaveBeenCalled();
    },
  );

  it("queues the send once the domain is VERIFIED", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue(domain("VERIFIED"));
    const res = await send();
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("queued");
    expect(mockEnqueueSend).toHaveBeenCalledWith({
      messageId: expect.any(String),
      carrierId: CARRIER.id,
    });
  });

  it("still rejects a foreign project's domain before it looks at status", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue({ ...domain("VERIFIED"), projectId: "proj_other" });
    const res = await send();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("domain_not_allowed");
  });

  it("passes the gate for a shared (projectId: null) VERIFIED domain", async () => {
    mockPrisma.domain.findUnique.mockResolvedValue({ ...domain("VERIFIED"), projectId: null });
    const res = await send();
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("queued");
  });
});
