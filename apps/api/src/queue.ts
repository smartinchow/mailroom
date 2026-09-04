import { Queue } from "bullmq";
import { newRedis } from "./redis.js";

export interface SendJobData {
  messageId: string;
  carrierId: string;
  /** Set when this send is the one-shot fallback after primary exhaustion. */
  isFallback?: boolean;
}

export const SEND_QUEUE = "send";
export const MAINTENANCE_QUEUE = "maintenance";

export const sendQueue = new Queue<SendJobData>(SEND_QUEUE, {
  connection: newRedis(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { age: 24 * 3600, count: 5000 },
    removeOnFail: false,
  },
});

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
  connection: newRedis(),
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
});

export async function enqueueSend(data: SendJobData): Promise<void> {
  await sendQueue.add("send", data);
}

/** Repeatable maintenance jobs. Job name is the dispatch key in worker.ts. */
export const PURGE_BODIES_JOB = "purge-bodies";
export const DOMAIN_VERIFY_JOB = "domain-verify";

/**
 * Nightly retention purge (design §10.3) at 03:10 local, plus the five-minute
 * sending-domain verification sweep (domains spec §7).
 */
export async function scheduleMaintenance(): Promise<void> {
  await maintenanceQueue.upsertJobScheduler(PURGE_BODIES_JOB, { pattern: "10 3 * * *" });
  await maintenanceQueue.upsertJobScheduler(DOMAIN_VERIFY_JOB, { pattern: "*/5 * * * *" });
}
