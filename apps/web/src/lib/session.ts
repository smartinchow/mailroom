/**
 * Signed session tokens. HMAC-SHA256 via Web Crypto so the same code runs in
 * the middleware (edge-compatible runtime) and in Node server actions.
 *
 * Token format: base64url(JSON payload) + "." + base64url(HMAC of payload part)
 */

export const SESSION_COOKIE = "mailroom_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const encoder = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time byte comparison (length leak only). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time string comparison for secrets of possibly different lengths:
 * compare SHA-256 digests so timing does not depend on where they differ.
 */
export async function constantTimeStringEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqualBytes(new Uint8Array(da), new Uint8Array(db));
}

export interface SessionPayload {
  iat: number;
  exp: number;
}

export async function createSessionToken(
  secret: string,
  ttlMs: number = SESSION_TTL_MS,
  now: number = Date.now(),
): Promise<string> {
  const payload: SessionPayload = { iat: now, exp: now + ttlMs };
  const payloadPart = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadPart);
  return `${payloadPart}.${bytesToB64url(sig)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadPart, sigPart] = parts;
  const givenSig = b64urlToBytes(sigPart);
  if (!givenSig) return false;
  const expectedSig = await hmacSign(secret, payloadPart);
  if (!timingSafeEqualBytes(expectedSig, givenSig)) return false;
  const payloadBytes = b64urlToBytes(payloadPart);
  if (!payloadBytes) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}
