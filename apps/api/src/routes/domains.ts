import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireApiKey } from "../auth.js";
import {
  DomainError,
  checkDomain,
  createDomain,
  deleteDomain,
  toPublicDomain,
} from "../domains.js";

/**
 * Project-scoped sending domains (spec §4). API-key auth throughout; a key
 * only ever sees its own project's domains — shared (projectId = null) domains
 * are administered from the dashboard, never listed here.
 */

const domainInclude = { carrier: { select: { id: true, name: true, type: true } } };

/** DomainError → `{ error: "<code>", ... }`, the shape every other route uses. */
export function sendDomainError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DomainError) {
    return reply.code(err.status).send({ error: err.code, ...err.extra });
  }
  throw err;
}

export function registerDomainRoutes(app: FastifyInstance): void {
  const createSchema = z.object({ name: z.string().min(3).max(253) });

  app.post("/v1/domains", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      // Public callers never choose a carrier: always the platform default.
      const domain = await createDomain({ name: parsed.data.name, projectId: ctx.project.id });
      return reply.code(201).send(toPublicDomain(domain));
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get("/v1/domains", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const domains = await prisma.domain.findMany({
      where: { projectId: ctx.project.id },
      orderBy: { name: "asc" },
      include: domainInclude,
    });
    return reply.send({ data: domains.map(toPublicDomain) });
  });

  app.get("/v1/domains/:id", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const domain = await prisma.domain.findFirst({
      where: { id, projectId: ctx.project.id },
      include: domainInclude,
    });
    if (!domain) return reply.code(404).send({ error: "not_found" });
    return reply.send(toPublicDomain(domain));
  });

  app.post("/v1/domains/:id/verify", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const owned = await prisma.domain.findFirst({ where: { id, projectId: ctx.project.id }, select: { id: true } });
    if (!owned) return reply.code(404).send({ error: "not_found" });
    try {
      return reply.send(toPublicDomain(await checkDomain(id)));
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.delete("/v1/domains/:id", async (req, reply) => {
    const ctx = await requireApiKey(req, reply);
    if (!ctx) return;
    const { id } = req.params as { id: string };
    const owned = await prisma.domain.findFirst({ where: { id, projectId: ctx.project.id }, select: { id: true } });
    if (!owned) return reply.code(404).send({ error: "not_found" });
    try {
      await deleteDomain(id);
      return reply.code(204).send();
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });
}
