/**
 * Server-side admin API client. The admin token lives only in process.env and
 * is attached here; this module must never be imported from client code.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Parsed JSON error body, e.g. `{ error: "domain_exists" }`, when the response was JSON. */
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Read the `error` code off an admin API error body, e.g. "domain_exists". */
export function apiErrorCode(err: unknown): string | undefined {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const code = (err.body as { error?: unknown }).error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function requireEnv(name: "API_URL" | "ADMIN_API_TOKEN"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof window !== "undefined") {
    throw new Error("Admin API client must not run in the browser");
  }
  const base = requireEnv("API_URL").replace(/\/+$/, "");
  const token = requireEnv("ADMIN_API_TOKEN");

  const res = await fetch(`${base}/v1/admin${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "x-admin-token": token,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, `Admin API ${res.status} on ${path}: ${text.slice(0, 300)}`, body);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Build a query string from possibly-empty filter values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length > 0) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
