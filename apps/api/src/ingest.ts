import type { CarrierType } from "@prisma/client";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { eventLag, messagesTotal, suppressionsTotal } from "./metrics.js";
import { addSuppression } from "./suppression.js";
import { advanceStatus } from "./status.js";
import type { NormalizedEvent } from "./carriers/types.js";

/**
 * Idempotent event ingest. Unique (messageId, type, occurredAt) absorbs
 * duplicates; advanceStatus refuses regressions and stale events.
 */
export async function ingestEvents(carrierType: CarrierType, events: NormalizedEvent[]): Promise<void> {
  for (const ev of events) {
    if (!ev.providerMessageId) continue;
    const message = await prisma.message.findFirst({
      where: { providerMessageId: ev.providerMessageId },
    });
    if (!message) {
      logger.warn({ providerMessageId: ev.providerMessageId, type: ev.type }, "event for unknown message");
      continue;
    }

    const created = await prisma.messageEvent
      .create({
        data: {
          messageId: message.id,
          type: ev.type,
          recipient: ev.recipient,
          occurredAt: ev.occurredAt,
          providerRaw: ev.providerRaw as object,
        },
      })
      .catch((e: unknown) => {
        // P2002 = duplicate (messageId, type, occurredAt) — already ingested.
        if ((e as { code?: string }).code === "P2002") return null;
        throw e;
      });
    if (!created) continue;

    eventLag.labels(carrierType.toLowerCase()).observe(Math.max(0, (Date.now() - ev.occurredAt.getTime()) / 1000));

    const { next } = advanceStatus(message.status, message.lastEventAt, ev.type, ev.occurredAt);
    await prisma.message.update({
      where: { id: message.id },
      data: {
        ...(next ? { status: next } : {}),
        lastEventAt:
          message.lastEventAt == null || ev.occurredAt > message.lastEventAt
            ? ev.occurredAt
            : undefined,
        ...(next === "FAILED" || next === "BOUNCED" ? { lastError: ev.detail ?? undefined } : {}),
      },
    });
    if (next) messagesTotal.labels(carrierType.toLowerCase(), next).inc();

    if (ev.suppress && ev.recipient) {
      await addSuppression({
        address: ev.recipient,
        reason: ev.suppress.reason,
        messageId: message.id,
      });
      suppressionsTotal.labels(ev.suppress.reason).inc();
    }

    logger.info(
      { messageId: message.id, type: ev.type, status: next ?? message.status },
      "event ingested",
    );
  }
}
