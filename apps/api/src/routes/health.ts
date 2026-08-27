import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { registry } from "../metrics.js";
import { sendQueue } from "../queue.js";
import { queueDepth } from "../metrics.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = "ok";
    } catch {
      checks.db = "down";
      healthy = false;
    }
    try {
      await redis.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "down";
      healthy = false;
    }
    let carriers: { name: string; type: string; enabled: boolean }[] = [];
    try {
      carriers = (await prisma.carrier.findMany()).map((c) => ({
        name: c.name,
        type: c.type,
        enabled: c.enabled,
      }));
    } catch {
      // db check already covers this
    }
    return reply.code(healthy ? 200 : 503).send({ ...checks, carriers });
  });

  app.get("/metrics", async (_req, reply) => {
    try {
      const counts = await sendQueue.getJobCounts("waiting", "delayed", "active");
      queueDepth.labels("send").set((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0));
    } catch {
      // leave the last observed value
    }
    reply.header("content-type", registry.contentType);
    return reply.send(await registry.metrics());
  });
}
