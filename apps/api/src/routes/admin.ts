import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { encrypt, generateApiKey } from "../crypto.js";
import { requireAdminToken } from "../auth.js";
import { addSuppression } from "../suppression.js";
import { invalidateCarrierCache } from "../carriers/index.js";
import { sendQueue } from "../queue.js";

const carrierConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("acs"), connectionString: z.string().min(10), resourceId: z.string().min(10) }),
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
  });

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
    return reply.code(201).send({ id: carrier.id, name: carrier.name, type: carrier.type });
  });

  app.patch("/v1/admin/carriers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      config: carrierConfigSchema.optional(),
      ratePerSecond: z.number().int().min(1).optional(),
      ratePerHour: z.number().int().min(1).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { config, ...rest } = parsed.data;
    const carrier = await prisma.carrier.update({
      where: { id },
      data: { ...rest, ...(config ? { configEnc: encrypt(JSON.stringify(config)) } : {}) },
    });
    invalidateCarrierCache(id);
    return reply.send({ id: carrier.id, name: carrier.name, enabled: carrier.enabled });
  });

  // ---- Domains ----

  app.get("/v1/admin/domains", async (_req, reply) => {
    const domains = await prisma.domain.findMany({
      orderBy: { name: "asc" },
      include: { project: { select: { slug: true } }, carrier: { select: { name: true } } },
    });
    return reply.send(
      domains.map((d) => ({
        id: d.id,
        name: d.name,
        projectId: d.projectId,
        projectSlug: d.project?.slug ?? null,
        carrierId: d.carrierId,
        carrierName: d.carrier.name,
        fallbackCarrierId: d.fallbackCarrierId,
        verifiedAt: d.verifiedAt,
        notes: d.notes,
      })),
    );
  });

  const domainSchema = z.object({
    name: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
    projectId: z.string().nullable().optional(),
    carrierId: z.string(),
    fallbackCarrierId: z.string().nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  });

  app.post("/v1/admin/domains", async (req, reply) => {
    const parsed = domainSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    const domain = await prisma.domain.create({ data: { ...parsed.data, name: parsed.data.name.toLowerCase() } });
    return reply.code(201).send(domain);
  });

  app.patch("/v1/admin/domains/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = domainSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const domain = await prisma.domain.update({ where: { id }, data: parsed.data });
    return reply.send(domain);
  });

  app.delete("/v1/admin/domains/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.domain.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  app.get("/v1/admin/hook-urls", async (_req, reply) => {
    const base = env().PUBLIC_URL.replace(/\/$/, "");
    return reply.send({
      acs: `${base}/v1/hooks/acs/${env().HOOK_SECRET}`,
      ses: `${base}/v1/hooks/ses/${env().HOOK_SECRET}`,
    });
  });
}
