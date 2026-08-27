import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { messagesTotal, sendDuration } from "./metrics.js";
import { newRedis } from "./redis.js";
import { redis } from "./redis.js";
import { carrierFor } from "./carriers/index.js";
import type { OutboundMessage } from "./carriers/types.js";
import { MAINTENANCE_QUEUE, SEND_QUEUE, sendQueue, type SendJobData } from "./queue.js";
import { purgeExpiredBodies } from "./purge.js";

/**
 * Send worker. Rate limits are sliding one-second and one-hour windows in
 * Redis, per carrier plus an optional per-project hourly cap — several
 * projects sharing one ACS resource share its quota (design §8).
 */

interface RateVerdict {
  ok: boolean;
  retryAtMs?: number;
}

async function takeRateSlot(params: {
  carrierId: string;
  ratePerSecond: number;
  ratePerHour: number;
  projectId: string;
  projectHourlyCap: number | null;
}): Promise<RateVerdict> {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const hour = Math.floor(now / 3_600_000);

  const secKey = `rl:c:${params.carrierId}:s:${sec}`;
  const hourKey = `rl:c:${params.carrierId}:h:${hour}`;
  const projKey = `rl:p:${params.projectId}:h:${hour}`;

  const [secCount, hourCount, projCount] = await redis
    .multi()
    .incr(secKey)
    .incr(hourKey)
    .incr(projKey)
    .expire(secKey, 2)
    .expire(hourKey, 3660)
    .expire(projKey, 3660)
    .exec()
    .then((r) => [r![0][1] as number, r![1][1] as number, r![2][1] as number]);

  const rollback = async () => {
    await redis.multi().decr(secKey).decr(hourKey).decr(projKey).exec();
  };

  if (hourCount > params.ratePerHour || (params.projectHourlyCap != null && projCount > params.projectHourlyCap)) {
    await rollback();
    return { ok: false, retryAtMs: (hour + 1) * 3_600_000 + Math.floor(Math.random() * 30_000) };
  }
  if (secCount > params.ratePerSecond) {
    await rollback();
    return { ok: false, retryAtMs: (sec + 1) * 1000 + Math.floor(Math.random() * 500) };
  }
  return { ok: true };
}

/** Errors worth retrying: throttling, transient server errors, network. */
function isRetryable(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
  const status = e.statusCode ?? e.status;
  if (status != null) return status === 429 || status >= 500;
  const code = e.code ?? "";
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code);
}

async function processSend(job: Job<SendJobData>, token?: string): Promise<void> {
  const { messageId, carrierId } = job.data;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { project: true, attachments: true },
  });
  if (!message) throw new UnrecoverableError(`message ${messageId} not found`);
  if (message.status !== "QUEUED" && message.status !== "SENDING") return; // already handled

  const carrierRow = await prisma.carrier.findUnique({ where: { id: carrierId } });
  if (!carrierRow || !carrierRow.enabled) throw new UnrecoverableError(`carrier ${carrierId} unavailable`);

  const slot = await takeRateSlot({
    carrierId,
    ratePerSecond: carrierRow.ratePerSecond,
    ratePerHour: carrierRow.ratePerHour,
    projectId: message.projectId,
    projectHourlyCap: message.project.hourlyCap,
  });
  if (!slot.ok) {
    await job.moveToDelayed(slot.retryAtMs!, token);
    throw new DelayedError();
  }

  await prisma.message.update({
    where: { id: messageId },
    data: { status: "SENDING", attempts: { increment: 1 } },
  });

  const outbound: OutboundMessage = {
    id: message.id,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo ?? undefined,
    subject: message.subject,
    // Bodies for sending come from the job-side copy in Redis? No — we send
    // what was stored. NOTE: with bodyRetention NONE/REDACTED the stored body
    // differs from the submitted one, so the API keeps the verbatim body in
    // the sendBody stash (redis) until the send succeeds.
    html: undefined,
    text: undefined,
    headers: (message.headers ?? {}) as Record<string, string>,
    attachments: [],
  };

  const stash = await redis.get(`sendbody:${message.id}`);
  if (stash) {
    const parsed = JSON.parse(stash) as {
      html?: string;
      text?: string;
      attachments?: { filename: string; contentType: string; content: string }[];
    };
    outbound.html = parsed.html;
    outbound.text = parsed.text;
    outbound.attachments = parsed.attachments ?? [];
  } else {
    // Stash lost (Redis flush): fall back to stored (possibly redacted) body
    // rather than silently dropping the send.
    outbound.html = message.bodyHtml ?? undefined;
    outbound.text = message.bodyText ?? undefined;
  }

  const carrier = carrierFor(carrierRow);
  const stop = sendDuration.labels(carrier.type).startTimer();
  try {
    const { providerMessageId } = await carrier.send(outbound);
    stop();
    await prisma.$transaction([
      prisma.message.update({
        where: { id: messageId },
        data: {
          status: "SENT",
          providerMessageId,
          sentAt: new Date(),
          carrierId: carrierRow.id,
          lastError: null,
        },
      }),
      prisma.messageEvent.create({
        data: {
          messageId,
          type: "SENT",
          occurredAt: new Date(),
          providerRaw: { carrier: carrier.type, providerMessageId },
        },
      }),
    ]);
    messagesTotal.labels(carrier.type, "SENT").inc();
    await redis.del(`sendbody:${message.id}`);
    logger.info({ messageId, providerMessageId, carrier: carrier.type }, "sent");
  } catch (err) {
    stop();
    const detail = err instanceof Error ? err.message : String(err);
    await prisma.message.update({ where: { id: messageId }, data: { lastError: detail.slice(0, 2000) } });
    logger.warn({ messageId, err: detail, attempt: job.attemptsMade + 1 }, "send attempt failed");
    if (isRetryable(err)) throw err;
    throw new UnrecoverableError(detail.slice(0, 2000));
  }
}

/** Terminal failure: try the domain fallback once, else mark FAILED loudly. */
async function onSendExhausted(job: Job<SendJobData>, err: Error): Promise<void> {
  const { messageId, isFallback } = job.data;
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { domain: true } });
  if (!message || message.status === "SENT" || message.status === "DELIVERED") return;

  if (!isFallback && message.domain.fallbackCarrierId) {
    logger.warn({ messageId, fallbackCarrierId: message.domain.fallbackCarrierId }, "primary exhausted, trying fallback");
    await prisma.message.update({ where: { id: messageId }, data: { status: "QUEUED" } });
    await sendQueue.add("send", {
      messageId,
      carrierId: message.domain.fallbackCarrierId,
      isFallback: true,
    });
    return;
  }

  await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: { status: "FAILED", lastError: err.message.slice(0, 2000) },
    }),
    prisma.messageEvent.create({
      data: {
        messageId,
        type: "FAILED",
        occurredAt: new Date(),
        providerRaw: { error: err.message.slice(0, 2000), attempts: job.attemptsMade },
      },
    }),
  ]);
  messagesTotal.labels("unknown", "FAILED").inc();
  await redis.del(`sendbody:${messageId}`);
  logger.error({ messageId, err: err.message }, "send exhausted, message FAILED");
}

export function startWorkers(): { close(): Promise<void> } {
  const sendWorker = new Worker<SendJobData>(SEND_QUEUE, processSend, {
    connection: newRedis(),
    concurrency: 5,
  });
  sendWorker.on("failed", (job, err) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError || err.name === "UnrecoverableError";
    if (exhausted) {
      void onSendExhausted(job, err).catch((e) => logger.error({ e }, "onSendExhausted failed"));
    }
  });

  const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, async () => purgeExpiredBodies(), {
    connection: newRedis(),
  });

  return {
    async close() {
      await Promise.all([sendWorker.close(), maintenanceWorker.close()]);
    },
  };
}
