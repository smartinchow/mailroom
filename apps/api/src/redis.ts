import { Redis } from "ioredis";
import { env } from "./env.js";

export function newRedis(): Redis {
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
}

export const redis = newRedis();
