import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { safeEqual } from "../crypto.js";
import { carrierFor } from "../carriers/index.js";
import { ingestEvents } from "../ingest.js";
import { logger } from "../logger.js";
import type { RawRequest } from "../carriers/types.js";

/**
 * Provider webhooks. Authenticated by the URL secret first; each adapter then
 * applies its own authenticity check (Event Grid topic assertion, SNS
 * signature). Always answer quickly — providers retry on non-2xx.
 */
export function registerHookRoutes(app: FastifyInstance): void {
  app.post("/v1/hooks/:type/:secret", async (req, reply) => {
    const { type, secret } = req.params as { type: string; secret: string };
    if (!safeEqual(secret, env().HOOK_SECRET)) {
      return reply.code(404).send(); // don't confirm the endpoint exists
    }
    const carrierType = type.toUpperCase();
    if (carrierType !== "ACS" && carrierType !== "SES") {
      return reply.code(404).send();
    }

    const rows = await prisma.carrier.findMany({ where: { type: carrierType as never, enabled: true } });
    if (rows.length === 0) {
      logger.warn({ type }, "hook received but no enabled carrier of this type");
      return reply.code(202).send({ ok: true });
    }

    // SNS posts JSON with Content-Type text/plain; Fastify's default parser
    // then hands us a string, which the adapter treats as the raw body.
    let body: unknown = req.body;
    let rawBody = (req as { rawBody?: string }).rawBody;
    if (typeof req.body === "string") {
      rawBody = req.body;
      try {
        body = JSON.parse(req.body);
      } catch {
        return reply.code(400).send({ error: "invalid_json" });
      }
    }
    const raw: RawRequest = { headers: req.headers, body, rawBody };

    let lastReason = "no carrier verified this payload";
    for (const row of rows) {
      const carrier = carrierFor(row);
      const verdict = await carrier.verifyHook(raw);
      if (!verdict.ok) {
        lastReason = verdict.reason;
        continue;
      }
      if ("respondWith" in verdict) {
        // Event Grid subscription validation / SNS subscription confirmation.
        return reply.code(200).send(verdict.respondWith);
      }
      const events = carrier.parseEvents(body);
      await ingestEvents(row.type, events);
      return reply.code(200).send({ ok: true, ingested: events.length });
    }

    logger.warn({ type, reason: lastReason }, "hook rejected");
    return reply.code(403).send({ error: "verification_failed" });
  });
}
