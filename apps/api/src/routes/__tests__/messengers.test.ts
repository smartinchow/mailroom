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

const PROJECT = {
  id: "proj_1",
  name: "Test Project",
  slug: "test-project",
  bodyRetention: "REDACTED" as const,
  bodyRetentionDays: 90,
  hourlyCap: null,
  createdAt: new Date(),
};

const TOKEN = "mr_live_test1234_supersecretsupersecret";
const TOKEN_PREFIX = "mr_live_test1234";
const API_KEY_ROW = {
  id: "key_1",
  projectId: PROJECT.id,
  name: "listmonk",
  prefix: TOKEN_PREFIX,
  keyHash: createHash("sha256").update(TOKEN).digest("hex"),
  lastUsedAt: null,
  revokedAt: null as Date | null,
  createdAt: new Date(),
  project: PROJECT,
};

const CARRIER = {
  id: "carrier_1",
  type: "SMTP" as const,
  name: "test-carrier",
  configEnc: "v1.aa.bb.cc",
  enabled: true,
  isDefault: false,
  ratePerSecond: 1,
  ratePerHour: 100,
  createdAt: new Date(),
};

const DOMAIN = {
  id: "domain_1",
  name: "maro.com.au",
  projectId: null as string | null,
  carrierId: CARRIER.id,
  fallbackCarrierId: null,
  verifiedAt: new Date(),
  notes: null,
  status: "VERIFIED" as const,
  dnsRecords: [],
  mailFromDomain: null,
  lastCheckedAt: null,
  verificationError: null,
  createdAt: new Date(),
  carrier: CARRIER,
};

function basicAuthHeader(): string {
  return "Basic " + Buffer.from("maro:" + TOKEN).toString("base64");
}

const mockPrisma = {
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  domain: {
    findUnique: vi.fn(),
  },
  suppression: {
    findFirst: vi.fn().mockResolvedValue(null),
  },
  message: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  },
};

const mockEnqueueSend = vi.fn().mockResolvedValue(undefined);
const mockRedisSet = vi.fn().mockResolvedValue("OK");

vi.mock("../../db.js", () => ({ prisma: mockPrisma }));
vi.mock("../../redis.js", () => ({ redis: { set: mockRedisSet }, newRedis: vi.fn() }));
vi.mock("../../queue.js", () => ({
  enqueueSend: mockEnqueueSend,
  sendQueue: {},
  maintenanceQueue: {},
  scheduleMaintenance: vi.fn(),
  SEND_QUEUE: "send",
  MAINTENANCE_QUEUE: "maintenance",
}));

let app: Fastify.FastifyInstance;

beforeAll(async () => {
  const FastifyModule = (await import("fastify")).default;
  const { registerMessengerRoutes } = await import("../messengers.js");
  app = FastifyModule();
  registerMessengerRoutes(app);
  await app.ready();
});

afterEach(() => {
  mockPrisma.apiKey.findUnique.mockReset();
  mockPrisma.apiKey.update.mockReset().mockResolvedValue({});
  mockPrisma.domain.findUnique.mockReset();
  mockPrisma.suppression.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.message.findUnique.mockReset().mockResolvedValue(null);
  mockPrisma.message.create.mockReset().mockResolvedValue({});
  mockEnqueueSend.mockReset().mockResolvedValue(undefined);
  mockRedisSet.mockReset().mockResolvedValue("OK");
});

function listmonkPayload(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Spring sale",
    content_type: "plain",
    body: "Hello from Maro.",
    recipients: [{ uuid: "r-1", email: "buyer@example.org", name: "Buyer One", status: "enabled" }],
    campaign: { uuid: "c-1111-2222", name: "Spring Sale", tags: ["sale"] },
    ...overrides,
  };
}

describe("POST /v1/messengers/listmonk", () => {
  it("rejects a request with no or invalid auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messengers/listmonk?from=hello@maro.com.au",
      payload: listmonkPayload(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_api_key" });
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a bad password even with a well-formed key shape", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(API_KEY_ROW);
    const badAuth = "Basic " + Buffer.from("maro:mr_live_test1234_wrongwrongwrongwrong").toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/v1/messengers/listmonk?from=hello@maro.com.au",
      headers: { authorization: badAuth },
      payload: listmonkPayload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("maps a good payload to one queued Message per recipient and returns 200 ok", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(API_KEY_ROW);
    mockPrisma.domain.findUnique.mockResolvedValue(DOMAIN);

    const payload = listmonkPayload();
    const res = await app.inject({
      method: "POST",
      url: "/v1/messengers/listmonk?from=" + encodeURIComponent("Maro <hello@maro.com.au>"),
      headers: { authorization: basicAuthHeader() },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
    const createArgs = mockPrisma.message.create.mock.calls[0][0];
    expect(createArgs.data.to).toEqual(["buyer@example.org"]);
    expect(createArgs.data.subject).toBe("Spring sale");
    expect(createArgs.data.bodyText).toBe("Hello from Maro.");
    expect(createArgs.data.tags).toEqual({ campaign: "Spring Sale", messenger: "listmonk" });

    const expectedKey = createHash("sha256").update("listmonk:c-1111-2222:buyer@example.org").digest("hex");
    expect(createArgs.data.idempotencyKey).toBe(expectedKey);

    expect(mockEnqueueSend).toHaveBeenCalledWith({ messageId: expect.any(String), carrierId: CARRIER.id });
  });

  it("treats a fully suppressed recipient list as 200 ok with no queued send", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(API_KEY_ROW);
    mockPrisma.domain.findUnique.mockResolvedValue(DOMAIN);
    mockPrisma.suppression.findFirst.mockResolvedValue({
      id: "sup_1",
      address: "buyer@example.org",
      scope: "GLOBAL",
      reason: "HARD_BOUNCE",
      messageId: null,
      createdAt: new Date(),
      expiresAt: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messengers/listmonk?from=" + encodeURIComponent("hello@maro.com.au"),
      headers: { authorization: basicAuthHeader() },
      payload: listmonkPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
    expect(mockEnqueueSend).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload has no from address and no from override", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(API_KEY_ROW);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messengers/listmonk",
      headers: { authorization: basicAuthHeader() },
      payload: listmonkPayload(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("from_required");
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });
});
