import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

/**
 * Key-versioned AES-256-GCM. Ciphertext format: "<keyId>.<iv b64url>.<tag b64url>.<ct b64url>".
 * MAILROOM_ENCRYPTION_KEY is the write key; MAILROOM_ENCRYPTION_KEYS_OLD are decrypt-only,
 * so rotation is: add new key, restart, re-save carriers, drop old key. No redeploy of data.
 */

type KeyRing = { writeId: string; keys: Map<string, Buffer> };

function parseKeySpec(spec: string, defaultId: string): [string, Buffer] {
  const idx = spec.indexOf(":");
  const [id, hex] = idx === -1 ? [defaultId, spec] : [spec.slice(0, idx), spec.slice(idx + 1)];
  const key = Buffer.from(hex.trim(), "hex");
  if (key.length !== 32) throw new Error(`encryption key "${id}" must be 32 bytes of hex`);
  return [id, key];
}

let ring: KeyRing | null = null;

function keyring(): KeyRing {
  if (ring) return ring;
  const keys = new Map<string, Buffer>();
  const [writeId, writeKey] = parseKeySpec(env().MAILROOM_ENCRYPTION_KEY, "v1");
  keys.set(writeId, writeKey);
  for (const spec of (env().MAILROOM_ENCRYPTION_KEYS_OLD ?? "").split(",").filter((s) => s.trim())) {
    const [id, key] = parseKeySpec(spec, `old${keys.size}`);
    if (!keys.has(id)) keys.set(id, key);
  }
  ring = { writeId, keys };
  return ring;
}

export function encrypt(plaintext: string): string {
  const { writeId, keys } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(writeId)!, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [writeId, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [keyId, ivB64, tagB64, ctB64] = payload.split(".");
  if (!keyId || !ivB64 || !tagB64 || !ctB64) throw new Error("malformed ciphertext");
  const key = keyring().keys.get(keyId);
  if (!key) throw new Error(`unknown encryption key id "${keyId}"`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time comparison of two hex digests / secrets of equal expected shape. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Generate an API key: returns { plaintext, prefix, hash }. Plaintext shown once. */
export function generateApiKey(live = true): { plaintext: string; prefix: string; hash: string } {
  const body = randomBytes(24).toString("base64url");
  const prefix = `mr_${live ? "live" : "test"}_${randomBytes(4).toString("hex")}`;
  const plaintext = `${prefix}_${body}`;
  return { plaintext, prefix, hash: sha256Hex(plaintext) };
}
