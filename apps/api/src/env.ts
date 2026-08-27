import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** 64-char hex AES-256-GCM key for carrier configs, format "<keyId>:<hex>" or bare hex (keyId "v1"). */
  MAILROOM_ENCRYPTION_KEY: z.string().min(64),
  /** Comma-separated "<keyId>:<hex>" pairs, decrypt-only, used during rotation. */
  MAILROOM_ENCRYPTION_KEYS_OLD: z.string().optional(),
  /** Public base URL, used to build hook URLs shown in the UI. */
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16),
  /** Shared secret the dashboard uses for /v1/admin/*. */
  ADMIN_API_TOKEN: z.string().min(16),
  /** Random path segment authenticating provider webhooks. */
  HOOK_SECRET: z.string().min(16),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
