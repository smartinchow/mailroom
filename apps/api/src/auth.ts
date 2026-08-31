import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKey, Project } from "@prisma/client";
import { prisma } from "./db.js";
import { safeEqual, sha256Hex } from "./crypto.js";
import { env } from "./env.js";

export interface AuthedContext {
  project: Project;
  apiKey: ApiKey;
}

/** Shared verification: token is a full mr_live_.../mr_test_... key. Hash is SHA-256, compared in constant time. */
async function resolveApiKey(token: string): Promise<AuthedContext | null> {
  // Prefix is the first three underscore-joined parts: mr_live_ab12cd34
  const parts = token.split("_");
  if (parts.length < 4 || parts[0] !== "mr") return null;
  const prefix = parts.slice(0, 3).join("_");

  const key = await prisma.apiKey.findUnique({ where: { prefix }, include: { project: true } });
  if (!key || key.revokedAt) return null;
  if (!safeEqual(sha256Hex(token), key.keyHash)) return null;

  // Fire-and-forget freshness stamp; never block the send on it.
  void prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { project: key.project, apiKey: key };
}

/** Bearer API key auth: Authorization: Bearer mr_live_... */
export async function authenticateApiKey(req: FastifyRequest): Promise<AuthedContext | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return resolveApiKey(header.slice(7).trim());
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<AuthedContext | undefined> {
  const ctx = await authenticateApiKey(req);
  if (!ctx) {
    await reply.code(401).send({ error: "invalid_api_key" });
    return undefined;
  }
  return ctx;
}

/**
 * HTTP Basic API key auth, for callers that cannot send arbitrary bearer headers
 * (e.g. listmonk postback messenger). Username is informational only -- the
 * password is the same mr_live_.../mr_test_... key Bearer auth accepts.
 */
export async function authenticateBasicApiKey(req: FastifyRequest): Promise<AuthedContext | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  const password = decoded.slice(sep + 1);
  return resolveApiKey(password);
}

export async function requireBasicApiKey(req: FastifyRequest, reply: FastifyReply): Promise<AuthedContext | undefined> {
  const ctx = await authenticateBasicApiKey(req);
  if (!ctx) {
    await reply.code(401).header("www-authenticate", "Basic realm=\"mailroom\"").send({ error: "invalid_api_key" });
    return undefined;
  }
  return ctx;
}

/** Dashboard-to-API auth: static shared token, constant-time compared. */
export function requireAdminToken(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = req.headers["x-admin-token"];
  if (typeof token !== "string" || !safeEqual(token, env().ADMIN_API_TOKEN)) {
    void reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}
