import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { encrypt, generateApiKey } from "../crypto.js";
import { requireAdminToken } from "../auth.js";
import { addSuppression } from "../suppression.js";
import { carrierFor, invalidateCarrierCache } from "../carriers/index.js";
import {
  DomainError,
  checkDomain,
  createDomain as createDomainRecord,
  deleteDomain as deleteDomainRecord,
  reprovisionDomain,
  toPublicDomain,
  type DomainWithCarrier,
} from "../domains.js";
import { sendQueue } from "../queue.js";

const carrierConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("acs"),
    connectionString: z.string().min(10),
    resourceId: z.string().min(10),
    // Optional: only an ACS carrier given ARM credentials can provision
    // sending domains. Omit it and the carrier stays "manual".
    arm: z
      .object({
        tenantId: z.string().min(1),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        subscriptionId: z.string().min(1),
        resourceGroup: z.string().min(1),
        emailServiceName: z.string().min(1),
        communicationServiceName: z.string().min(1),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("ses"),
    region: z.string().min(2),
    accessKeyId: z.string().min(4),
    secretAccessKey: z.string().min(8),
    configurationSet: z.string().optional(),
  }),
  z.object({
    type: z.literal("smtp"),
    host: z.string().min(2),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().optional(),
    pass: z.string().optional(),
  }),
]);

/**
 * Admin rows are the public §3 object plus the operator-only fields. The
 * dashboard reads exactly this shape.
 */
type AdminDomainRow = DomainWithCarrier & { project?: { slug: string } | null };

function toAdminDomain(d: AdminDomainRow) {
  return {
    ...toPublicDomain(d),
    projectSlug: d.project?.slug ?? null,
    carrierId: d.carrierId,
    fallbackCarrierId: d.fallbackCarrierId,
    notes: d.notes,
  };
}

function sendAdminDomainError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DomainError) return reply.code(err.status).send({ error: err.code, ...err.extra });
  throw err;
}

const adminDomainInclude = {
  carrier: { select: { id: true, name: true, type: true } },
  project: { select: { slug: true } },
};

export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/admin/")) return;
    if (!requireAdminToken(req, reply)) return reply;
  });

  app.get("/v1/admin/overview", async (_req, reply) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const grouped = await prisma.message.groupBy({
      by: ["status"],
      where: { queuedAt: { gte: since } },
      _count: { _all: true },
    });
    const last24h: Record<string, number> = {};
    for (const g of grouped) last24h[g.status] = g._count._all;

    const counts = await sendQueue.getJobCounts("waiting", "delayed", "active");
    const carriers = await prisma.carrier.findMany({ orderBy: { createdAt: "asc" } });
    const carrierCards = await Promise.all(
      carriers.map(async (c) => {
        const lastSent = await prisma.message.findFirst({
          where: { carrierId: c.id, sentAt: { not: null } },
          orderBy: { sentAt: "desc" },
          select: { sentAt: true },
        });
        const recentFailures = await prisma.message.count({
          where: { carrierId: c.id, status: "FAILED", queuedAt: { gte: since } },
        });
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          enabled: c.enabled,
          ratePerHour: c.ratePerHour,
          lastSendAt: lastSent?.sentAt ?? null,
          recentFailures,
        };
      }),
    );
    return reply.send({
      last24h,
      queueDepth: (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0),
      carriers: carrierCards,
    });
  });

  app.get("/v1/admin/messages", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 50) || 50, 100);
    const where: Prisma.MessageWhereInput = {};
    if (q.projectId) where.projectId = q.projectId;
    if (q.status) where.status = q.status.toUpperCase() as never;
    if (q.domain) where.domain = { name: q.domain.toLowerCase() };
    if (q.template) where.tags = { path: ["template"], equals: q.template };
    if (q.to) where.to = { has: q.to.toLowerCase() };
    if (q.q) {
      where.OR = [
        { subject: { contains: q.q, mode: "insensitive" } },
        { to: { has: q.q.toLowerCase() } },
        { from: { contains: q.q, mode: "insensitive" } },
      ];
    }
    if (q.after || q.before) {
      where.queuedAt = {
        ...(q.after ? { gte: new Date(q.after) } : {}),
        ...(q.before ? { lte: new Date(q.before) } : {}),
      };
    }
    if (q.cursor) where.id = { lt: q.cursor };

    const items = await prisma.message.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit + 1,
      include: { project: { select: { slug: true } }, carrier: { select: { type: true } } },
    });
    const nextCursor = items.length > limit ? items[limit - 1].id : null;
    return reply.send({
      items: items.slice(0, limit).map((m) => ({
        id: m.id,
        queuedAt: m.queuedAt,
        projectSlug: m.project.slug,
        to: m.to,
        subject: m.subject,
        tags: m.tags,
        carrierType: m.carrier.type,
        status: m.status,
        redactedLinkCount: m.redactedLinkCount,
      })),
      nextCursor,
    });
  });

  app.get("/v1/admin/messages/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await prisma.message.findUnique({
      where: { id },
      include: {
        project: { select: { slug: true } },
        carrier: { select: { name: true, type: true } },
        domain: { select: { name: true } },
        events: { orderBy: { occurredAt: "asc" } },
        attachments: true,
      },
    });
    if (!m) return reply.code(404).send({ error: "not_found" });
    const { bodyHtml, bodyText, events, attachments, ...rest } = m;
    return reply.send({
      message: {
        ...rest,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          bytes: a.bytes,
          sha256: a.sha256,
        })),
      },
      bodyHtml,
      bodyText,
      bodyPurgedAt: m.bodyPurgedAt,
      redactedLinkCount: m.redactedLinkCount,
      events: events.map((e) => ({
        type: e.type,
        recipient: e.recipient,
        occurredAt: e.occurredAt,
        providerRaw: e.providerRaw,
        receivedAt: e.receivedAt,
      })),
    });
  });

  app.get("/v1/admin/suppressions", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = 100;
    const where: Prisma.SuppressionWhereInput = q.q ? { address: { contains: q.q.toLowerCase() } } : {};
    if (q.cursor) where.id = { lt: q.cursor };
    const items = await prisma.suppression.findMany({ where, orderBy: { id: "desc" }, take: limit + 1 });
    return reply.send({
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? items[limit - 1].id : null,
    });
  });

  app.post("/v1/admin/suppressions", async (req, reply) => {
    const schema = z.object({ address: z.string().email(), scope: z.string().default("GLOBAL") });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    await addSuppression({ address: parsed.data.address, scope: parsed.data.scope, reason: "MANUAL" });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/v1/admin/suppressions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.suppression.delete({ where: { id } }).catch(() => {});
    return reply.send({ ok: true });
  });

  // ---- Projects & API keys ----

  app.get("/v1/admin/projects", async (_req, reply) => {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { apiKeys: { where: { revokedAt: null } }, domains: true } } },
    });
    return reply.send(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        bodyRetention: p.bodyRetention,
        bodyRetentionDays: p.bodyRetentionDays,
        hourlyCap: p.hourlyCap,
        createdAt: p.createdAt,
        keyCount: p._count.apiKeys,
        domainCount: p._count.domains,
      })),
    );
  });

  const projectSchema = z.object({
    name: z.string().min(1).max(100),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64),
    bodyRetention: z.enum(["NONE", "REDACTED", "FULL"]).optional(),
    bodyRetentionDays: z.number().int().min(1).max(3650).optional(),
    hourlyCap: z.number().int().min(1).nullable().optional(),
  });

  app.post("/v1/admin/projects", async (req, reply) => {
    const parsed = projectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    const project = await prisma.project.create({ data: parsed.data });
    return reply.code(201).send(project);
  });

  app.patch("/v1/admin/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = projectSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const project = await prisma.project.update({ where: { id }, data: parsed.data });
    return reply.send(project);
  });

  app.post("/v1/admin/projects/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({ name: z.string().min(1).max(100) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { plaintext, prefix, hash } = generateApiKey();
    const key = await prisma.apiKey.create({
      data: { projectId: id, name: parsed.data.name, prefix, keyHash: hash },
    });
    // Plaintext returned exactly once; only the hash is stored.
    return reply.code(201).send({ id: key.id, prefix, plaintext });
  });

  app.get("/v1/admin/projects/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    const keys = await prisma.apiKey.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
    return reply.send(
      keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        createdAt: k.createdAt,
      })),
    );
  });

  app.delete("/v1/admin/keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return reply.send({ ok: true });
  });

  // ---- Carriers ----

  app.get("/v1/admin/carriers", async (_req, reply) => {
    const carriers = await prisma.carrier.findMany({ orderBy: { createdAt: "asc" } });
    // configEnc is never returned, even encrypted.
    return reply.send(
      carriers.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        enabled: c.enabled,
        isDefault: c.isDefault,
        ratePerSecond: c.ratePerSecond,
        ratePerHour: c.ratePerHour,
        createdAt: c.createdAt,
      })),
    );
  });

  const carrierCreateSchema = z.object({
    name: z.string().min(1).max(100),
    type: z.enum(["ACS", "SES", "SMTP"]),
    config: carrierConfigSchema,
    ratePerSecond: z.number().int().min(1).default(1),
    ratePerHour: z.number().int().min(1).default(100),
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  });

  /** Exactly one carrier is default; clearing the others is part of the same transaction. */
  async function setDefaultCarrier(id: string): Promise<void> {
    await prisma.$transaction([
      prisma.carrier.updateMany({ where: { id: { not: id } }, data: { isDefault: false } }),
      prisma.carrier.update({ where: { id }, data: { isDefault: true } }),
    ]);
  }

  app.post("/v1/admin/carriers", async (req, reply) => {
    const parsed = carrierCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    if (parsed.data.config.type !== parsed.data.type.toLowerCase()) {
      return reply.code(400).send({ error: "config_type_mismatch" });
    }
    const carrier = await prisma.carrier.create({
      data: {
        name: parsed.data.name,
        type: parsed.data.type,
        configEnc: encrypt(JSON.stringify(parsed.data.config)),
        ratePerSecond: parsed.data.ratePerSecond,
        ratePerHour: parsed.data.ratePerHour,
        enabled: parsed.data.enabled,
      },
    });
    if (parsed.data.isDefault) await setDefaultCarrier(carrier.id);
    return reply.code(201).send({
      id: carrier.id,
      name: carrier.name,
      type: carrier.type,
      isDefault: parsed.data.isDefault,
    });
  });

  app.patch("/v1/admin/carriers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      config: carrierConfigSchema.optional(),
      ratePerSecond: z.number().int().min(1).optional(),
      ratePerHour: z.number().int().min(1).optional(),
      enabled: z.boolean().optional(),
      isDefault: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { config, isDefault, ...rest } = parsed.data;
    let carrier = await prisma.carrier.update({
      where: { id },
      data: {
        ...rest,
        ...(isDefault === false ? { isDefault: false } : {}),
        ...(config ? { configEnc: encrypt(JSON.stringify(config)) } : {}),
      },
    });
    // true promotes this carrier and demotes every other one; false only clears.
    if (isDefault === true) {
      await setDefaultCarrier(id);
      carrier = { ...carrier, isDefault: true };
    }
    invalidateCarrierCache(id);
    return reply.send({
      id: carrier.id,
      name: carrier.name,
      enabled: carrier.enabled,
      isDefault: carrier.isDefault,
    });
  });

  /**
   * SES account sending limits — invaluable while the account is still in the
   * sandbox. Carriers that cannot report limits 404 (the capability check lives
   * on the adapter, so there is no provider branch here).
   */
  app.get("/v1/admin/carriers/:id/quota", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.carrier.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    const carrier = carrierFor(row);
    if (!carrier.accountQuota) return reply.code(404).send({ error: "quota_not_supported" });
    try {
      return reply.send(await carrier.accountQuota());
    } catch (err) {
      return reply.code(502).send({
        error: "provider_error",
        message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
    }
  });

  // ---- Domains ----

  app.get("/v1/admin/domains", async (_req, reply) => {
    const domains = await prisma.domain.findMany({
      orderBy: { name: "asc" },
      include: adminDomainInclude,
    });
    return reply.send(domains.map(toAdminDomain));
  });

  const domainSchema = z.object({
    name: z.string().min(3).max(253),
    projectId: z.string().nullable().optional(),
    carrierId: z.string().nullable().optional(),
    fallbackCarrierId: z.string().nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  });

  app.get("/v1/admin/domains/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const domain = await prisma.domain.findUnique({ where: { id }, include: adminDomainInclude });
    if (!domain) return reply.code(404).send({ error: "not_found" });
    return reply.send(toAdminDomain(domain));
  });

  app.post("/v1/admin/domains", async (req, reply) => {
    const parsed = domainSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    try {
      // Same service as the public route: provisions on the carrier when it
      // supports it, falls back to a manual (already VERIFIED) domain.
      const domain = await createDomainRecord(parsed.data);
      const full = await prisma.domain.findUniqueOrThrow({
        where: { id: domain.id },
        include: adminDomainInclude,
      });
      return reply.code(201).send(toAdminDomain(full));
    } catch (err) {
      return sendAdminDomainError(reply, err);
    }
  });

  app.patch("/v1/admin/domains/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = domainSchema.partial().omit({ name: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { carrierId, ...rest } = parsed.data;
    try {
      // A bare FK write would move the domain to a carrier that has never
      // heard of it — VERIFIED here, registered nowhere, every send failing at
      // the provider. The dashboard's carrier select posts through this route,
      // so a carrier change is routed to the same service the reprovision
      // endpoint uses; only the metadata fields are written directly.
      if (carrierId) await reprovisionDomain(id, carrierId);
      const domain = await prisma.domain.update({
        where: { id },
        data: rest,
        include: adminDomainInclude,
      });
      return reply.send(toAdminDomain(domain));
    } catch (err) {
      return sendAdminDomainError(reply, err);
    }
  });

  app.post("/v1/admin/domains/:id/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const domain = await checkDomain(id);
      const full = await prisma.domain.findUniqueOrThrow({
        where: { id: domain.id },
        include: adminDomainInclude,
      });
      return reply.send(toAdminDomain(full));
    } catch (err) {
      return sendAdminDomainError(reply, err);
    }
  });

  const reprovisionSchema = z.object({ carrierId: z.string().min(1) });

  /**
   * Move a domain onto another carrier and register it there — operator-only,
   * so it is deliberately absent from `/v1/domains`. The row keeps its id and
   * its message log; moving a verified domain onto a provisioning carrier
   * drops it to PENDING and it cannot send until that carrier verifies it.
   */
  app.post("/v1/admin/domains/:id/reprovision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = reprovisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    try {
      const domain = await reprovisionDomain(id, parsed.data.carrierId);
      const full = await prisma.domain.findUniqueOrThrow({
        where: { id: domain.id },
        include: adminDomainInclude,
      });
      return reply.send(toAdminDomain(full));
    } catch (err) {
      return sendAdminDomainError(reply, err);
    }
  });

  app.delete("/v1/admin/domains/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // Also removes the provider identity; 409 when the message log needs it.
      await deleteDomainRecord(id);
      return reply.send({ ok: true });
    } catch (err) {
      return sendAdminDomainError(reply, err);
    }
  });

  app.get("/v1/admin/hook-urls", async (_req, reply) => {
    const base = env().PUBLIC_URL.replace(/\/$/, "");
    return reply.send({
      acs: `${base}/v1/hooks/acs/${env().HOOK_SECRET}`,
      ses: `${base}/v1/hooks/ses/${env().HOOK_SECRET}`,
    });
  });
}
