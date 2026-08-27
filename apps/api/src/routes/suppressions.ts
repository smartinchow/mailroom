import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireApiKey } from "../auth.js";
import { addSuppression } from "../suppression.js";

/** API-key-facing suppression management (design §6). */
export function registerSuppressionRoutes(app: FastifyInstance): void {
  app.get("/v1/suppressions", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const items = await prisma.suppression.findMany({
      where: q.q ? { address: { contains: q.q.toLowerCase() } } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return reply.send({
      items: items.map((s) => ({
        address: s.address,
        scope: s.scope,
        reason: s.reason,
        message_id: s.messageId,
        created_at: s.createdAt,
        expires_at: s.expiresAt,
      })),
    });
  });

  app.post("/v1/suppressions", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const schema = z.object({
      address: z.string().email(),
      scope: z.string().default("GLOBAL"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    // A key may only scope suppressions to GLOBAL or its own project's domains.
    const scope = parsed.data.scope.toLowerCase() === "global" ? "GLOBAL" : parsed.data.scope.toLowerCase();
    if (scope !== "GLOBAL") {
      const owned = await prisma.domain.findFirst({
        where: { name: scope, OR: [{ projectId: ctx.project.id }, { projectId: null }] },
      });
      if (!owned) return reply.code(403).send({ error: "scope_not_allowed" });
    }
    await addSuppression({ address: parsed.data.address, reason: "MANUAL", scope });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/v1/suppressions/:address", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const { address } = req.params as { address: string };
    // API keys may only lift MANUAL entries. HARD_BOUNCE / COMPLAINT rows are
    // estate-wide protection and removable only by the operator (admin API).
    await prisma.suppression.deleteMany({
      where: { address: address.toLowerCase(), reason: "MANUAL" },
    });
    return reply.send({ ok: true });
  });
}
