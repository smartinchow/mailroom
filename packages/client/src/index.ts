/**
 * @mailroom/client — typed, zero-dependency client for the Mailroom API.
 *
 * @example
 * ```ts
 * const mail = createMailroom({ url: process.env.MAILROOM_URL!, apiKey: process.env.MAILROOM_KEY! });
 * const { id, status } = await mail.send({ from, to, subject, html });
 * ```
 */

/** One outbound email. `to`, `cc` and `bcc` accept a single address or an array. */
export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  /** Sent as the `Idempotency-Key` header; replays return the original message. */
  idempotencyKey?: string;
}

/** Batch items carry no idempotency key — the header is per-request, not per-item. */
export type BatchEmailItem = Omit<SendEmailOptions, "idempotencyKey">;

export interface SendEmailResult {
  id: string;
  status: string;
}

export interface EmailEvent {
  type: string;
  recipient?: string;
  occurredAt: string;
  [key: string]: unknown;
}

/** A logged message. Body fields may be null under the project's retention policy. */
export interface EmailDetail {
  id: string;
  status: string;
  from: string;
  to: string[];
  subject: string;
  events?: EmailEvent[];
  [key: string]: unknown;
}

export interface ListEmailsOptions {
  status?: string;
  to?: string;
  domain?: string;
  template?: string;
  q?: string;
  after?: string;
  before?: string;
  cursor?: string;
  limit?: number;
}

export interface ListEmailsResult {
  data: EmailDetail[];
  cursor?: string | null;
  [key: string]: unknown;
}

/** Thrown on any non-2xx response, carrying the HTTP status and the parsed error body. */
export class MailroomError extends Error {
  readonly status: number;
  /** Parsed JSON error body, e.g. `{ error: "suppressed", address: "…" }`; null if unparsable. */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const code =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : undefined;
    super(code ? `Mailroom request failed (${status}): ${code}` : `Mailroom request failed (${status})`);
    this.name = "MailroomError";
    this.status = status;
    this.body = body;
  }
}

const toArray = (value: string | string[] | undefined): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/** camelCase options → snake_case wire body; single recipients → arrays. */
const toWire = (opts: BatchEmailItem): Record<string, unknown> => ({
  from: opts.from,
  to: toArray(opts.to),
  subject: opts.subject,
  html: opts.html,
  text: opts.text,
  reply_to: opts.replyTo,
  cc: toArray(opts.cc),
  bcc: toArray(opts.bcc),
  headers: opts.headers,
  tags: opts.tags,
});

export function createMailroom(config: { url: string; apiKey: string }) {
  const base = config.url.replace(/\/+$/, "");

  async function request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}`, ...opts.headers };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let errorBody: unknown = null;
      try {
        errorBody = await res.json();
      } catch {
        /* non-JSON error body */
      }
      throw new MailroomError(res.status, errorBody);
    }
    return (await res.json()) as T;
  }

  return {
    /** Queue one email. `POST /v1/emails` → `{ id, status }`. */
    send(opts: SendEmailOptions): Promise<SendEmailResult> {
      const headers: Record<string, string> = {};
      if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
      return request("POST", "/v1/emails", { body: toWire(opts), headers });
    },

    /** Queue up to 100 emails in one call. `POST /v1/emails/batch`, per-item results. */
    sendBatch(items: BatchEmailItem[]): Promise<SendEmailResult[]> {
      if (items.length > 100) {
        throw new RangeError(`sendBatch accepts at most 100 emails per call (got ${items.length})`);
      }
      return request("POST", "/v1/emails/batch", { body: items.map(toWire) });
    },

    /** Fetch one message with its normalized delivery events. `GET /v1/emails/:id`. */
    get(id: string): Promise<EmailDetail> {
      return request("GET", `/v1/emails/${encodeURIComponent(id)}`);
    },

    /** Search the message log. `GET /v1/emails?...`, cursor-paginated. */
    list(opts: ListEmailsOptions = {}): Promise<ListEmailsResult> {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(opts)) {
        if (value !== undefined) qs.set(key, String(value));
      }
      const query = qs.toString();
      return request("GET", `/v1/emails${query ? `?${query}` : ""}`);
    },
  };
}

export type Mailroom = ReturnType<typeof createMailroom>;
