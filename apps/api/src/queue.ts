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

/** Nightly retention purge (design §9.3), 03:10 local. */
export async function scheduleMaintenance(): Promise<void> {
  await maintenanceQueue.upsertJobScheduler("purge-bodies", { pattern: "10 3 * * *" });
}
