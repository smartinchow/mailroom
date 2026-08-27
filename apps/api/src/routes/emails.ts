import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
import type { Prisma, Project } from "@prisma/client";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { requireApiKey } from "../auth.js";
import { applyBodyPolicy } from "../redactor.js";
import { isSuppressed } from "../suppression.js";
import { enqueueSend } from "../queue.js";
import { logger } from "../logger.js";

const address = z.string().min(3).max(320);
const addressList = z.union([address, z.array(address).min(1).max(50)]).transform((v) => (Array.isArray(v) ? v : [v]));

const sendSchema = z.object({
  from: z.string().min(3).max(400),
  to: addressList,
  subject: z.string().min(1).max(998),
  html: z.string().max(2_000_000).optional(),
  text: z.string().max(2_000_000).optional(),
  reply_to: address.optional(),
  cc: z.array(address).max(50).default([]),
  bcc: z.array(address).max(50).default([]),
  headers: z.record(z.string()).default({}),
  tags: z.record(z.string()).default({}),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        content_type: z.string().min(3).max(255),
        content: z.string().max(10_000_000), // base64
      }),
    )
    .max(10)
    .default([]),
});

type SendInput = z.infer<typeof sendSchema>;

/** Extract the bare address from "Display Name <a@b.c>" or "a@b.c". */
export function bareAddress(from: string): string | null {
  const angled = from.match(/<([^<>]+)>\s*$/);
  const addr = (angled ? angled[1] : from).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr.toLowerCase() : null;
}

type SendOutcome =
  | { code: 202; body: { id: string; status: string } }
  | { code: 200; body: { id: string; status: string } }
  | { code: 400 | 403 | 409 | 422; body: { error: string; [k: string]: unknown } };

async function handleSend(project: Project, input: SendInput, idempotencyKey?: string): Promise<SendOutcome> {
  if (!input.html && !input.text) {
    return { code: 422, body: { error: "html_or_text_required" } };
  }

  const fromAddr = bareAddress(input.from);
  if (!fromAddr) return { code: 400, body: { error: "invalid_from" } };
  const fromDomain = fromAddr.split("@")[1];

  // D-07: a key may only send from its project's domains.
  const domain = await prisma.domain.findUnique({ where: { name: fromDomain }, include: { carrier: true } });
  if (!domain || (domain.projectId != null && domain.projectId !== project.id)) {
    return { code: 403, body: { error: "domain_not_allowed", domain: fromDomain } };
  }
  if (!domain.carrier.enabled) {
    return { code: 422, body: { error: "carrier_disabled", carrier: domain.carrier.name } };
  }

  for (const rcpt of [...input.to, ...input.cc, ...input.bcc]) {
    if (await isSuppressed(rcpt, fromDomain)) {
      return { code: 409, body: { error: "suppressed", address: rcpt.toLowerCase() } };
    }
  }

  if (idempotencyKey) {
    const existing = await prisma.message.findUnique({
      where: { projectId_idempotencyKey: { projectId: project.id, idempotencyKey } },
    });
    if (existing) return { code: 200, body: { id: existing.id, status: existing.status.toLowerCase() } };
  }

  const id = ulid();
  const stored = applyBodyPolicy({
    bodyRetention: project.bodyRetention,
    html: input.html,
    text: input.text,
  });

  // Verbatim body is stashed for the worker; the DB only ever holds the
  // policy-filtered copy (D-06). TTL outlives the longest retry window.
  await redis.set(
    `sendbody:${id}`,
    JSON.stringify({
      html: input.html,
      text: input.text,
      attachments: input.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.content_type,
        content: a.content,
      })),
    }),
    "EX",
    7 * 24 * 3600,
  );

  try {
    await prisma.message.create({
      data: {
        id,
        projectId: project.id,
        domainId: domain.id,
        carrierId: domain.carrierId,
        idempotencyKey,
        from: input.from,
        to: input.to.map((a) => a.toLowerCase()),
        cc: input.cc.map((a) => a.toLowerCase()),
        bcc: input.bcc.map((a) => a.toLowerCase()),
        replyTo: input.reply_to,
        subject: input.subject,
        bodyHtml: stored.bodyHtml,
        bodyText: stored.bodyText,
        headers: input.headers,
        tags: input.tags,
        redactedLinkCount: stored.redactedLinkCount,
        events: { create: { type: "QUEUED", occurredAt: new Date(), providerRaw: {} } },
        attachments: {
          create: input.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.content_type,
            bytes: Math.floor((a.content.length * 3) / 4),
            sha256: createHash("sha256").update(a.content).digest("hex"),
          })),
        },
      },
    });
  } catch (e: unknown) {
    await redis.del(`sendbody:${id}`);
    // Idempotency-key race: another request created it between check and insert.
    if ((e as { code?: string }).code === "P2002" && idempotencyKey) {
      const existing = await prisma.message.findUnique({
        where: { projectId_idempotencyKey: { projectId: project.id, idempotencyKey } },
      });
      if (existing) return { code: 200, body: { id: existing.id, status: existing.status.toLowerCase() } };
    }
    throw e;
  }

  await enqueueSend({ messageId: id, carrierId: domain.carrierId });
  logger.info({ messageId: id, projectId: project.id, domain: fromDomain }, "queued");
  return { code: 202, body: { id, status: "queued" } };
}

function serializeMessage(m: Prisma.MessageGetPayload<{ include: { events: true } }>, retention: string) {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    reply_to: m.replyTo,
    subject: m.subject,
    status: m.status.toLowerCase(),
    tags: m.tags,
    headers: m.headers,
    provider_message_id: m.providerMessageId,
    attempts: m.attempts,
    last_error: m.lastError,
    queued_at: m.queuedAt,
    sent_at: m.sentAt,
    last_event_at: m.lastEventAt,
    redacted_link_count: m.redactedLinkCount,
    body_purged_at: m.bodyPurgedAt,
    body_html: m.bodyHtml,
    body_text: m.bodyText,
    body_retention: retention.toLowerCase(),
    events: m.events.map((e) => ({
      type: e.type,
      recipient: e.recipient,
      occurred_at: e.occurredAt,
      received_at: e.receivedAt,
    })),
  };
}

export function registerEmailRoutes(app: FastifyInstance): void {
  app.post("/v1/emails", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 255);
    const outcome = await handleSend(ctx.project, parsed.data, idempotencyKey);
    return reply.code(outcome.code).send(outcome.body);
  });

  app.post("/v1/emails/batch", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const batchSchema = z.array(sendSchema).min(1).max(100);
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const results = [];
    for (const item of parsed.data) {
      try {
        const outcome = await handleSend(ctx.project, item);
        results.push({ ...outcome.body, _code: outcome.code });
      } catch (e) {
        logger.error({ err: e }, "batch item failed");
        results.push({ error: "internal_error", _code: 500 });
      }
    }
    return reply.code(200).send({ results });
  });

  app.get("/v1/emails/:id", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const message = await prisma.message.findFirst({
      where: { id, projectId: ctx.project.id },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    });
    if (!message) return reply.code(404).send({ error: "not_found" });
    return reply.send(serializeMessage(message, ctx.project.bodyRetention));
  });

  app.get("/v1/emails", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 50) || 50, 100);

    const where: Prisma.MessageWhereInput = { projectId: ctx.project.id };
    if (q.status) where.status = q.status.toUpperCase() as never;
    if (q.to) where.to = { has: q.to.toLowerCase() };
    if (q.domain) where.domain = { name: q.domain.toLowerCase() };
    if (q.template) where.tags = { path: ["template"], equals: q.template };
    if (q.q) where.subject = { contains: q.q, mode: "insensitive" };
    if (q.after || q.before) {
      where.queuedAt = {
        ...(q.after ? { gte: new Date(q.after) } : {}),
        ...(q.before ? { lte: new Date(q.before) } : {}),
      };
    }
    if (q.cursor) where.id = { lt: q.cursor }; // ULIDs sort by time

    const items = await prisma.message.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit + 1,
      select: {
        id: true,
        from: true,
        to: true,
        subject: true,
        status: true,
        tags: true,
        queuedAt: true,
        sentAt: true,
        lastEventAt: true,
        redactedLinkCount: true,
      },
    });
    const nextCursor = items.length > limit ? items[limit - 1].id : null;
    return reply.send({
      items: items.slice(0, limit).map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        status: m.status.toLowerCase(),
        tags: m.tags,
        queued_at: m.queuedAt,
        sent_at: m.sentAt,
        last_event_at: m.lastEventAt,
        redacted_link_count: m.redactedLinkCount,
      })),
      next_cursor: nextCursor,
    });
  });
}
