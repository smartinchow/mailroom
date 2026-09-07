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

/** Lower-cased on the wire: `pending | verified | failed | temporary_failure`. */
export type DomainStatus = "pending" | "verified" | "failed" | "temporary_failure";

/** Lower-cased on the wire. `domain_ownership` is the ACS domain-verification TXT. */
export type DnsRecordPurpose =
  | "dkim"
  | "mail_from_mx"
  | "mail_from_spf"
  | "dmarc"
  | "domain_ownership";

/** One DNS record to publish for domain verification. */
export interface DnsRecord {
  type: "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  priority?: number | null;
  ttl?: number | null;
  purpose: DnsRecordPurpose;
  required: boolean;
  status: "pending" | "verified" | "failed" | "not_started";
  /** Set only when the carrier rewrote the value (e.g. an SPF record merged with one already published). */
  note?: string | null;
}

/** A sending domain: created via `domains.create`, verified via `domains.verify`. */
export interface Domain {
  id: string;
  name: string;
  status: DomainStatus;
  carrier: { id: string; name: string; type: string };
  projectId: string | null;
  mailFromDomain: string | null;
  records: DnsRecord[];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  verificationError: string | null;
  createdAt: string;
}

/** Raw (snake_case) wire shape for a domain, as returned by the API. */
interface WireDomain {
  id: string;
  name: string;
  status: DomainStatus;
  carrier: { id: string; name: string; type: string };
  project_id: string | null;
  mail_from_domain: string | null;
  records: DnsRecord[];
  verified_at: string | null;
  last_checked_at: string | null;
  verification_error: string | null;
  created_at: string;
}

/** snake_case wire domain → camelCase `Domain`. */
const fromWireDomain = (raw: WireDomain): Domain => ({
  id: raw.id,
  name: raw.name,
  status: raw.status,
  carrier: raw.carrier,
  projectId: raw.project_id,
  mailFromDomain: raw.mail_from_domain,
  records: raw.records,
  verifiedAt: raw.verified_at,
  lastCheckedAt: raw.last_checked_at,
  verificationError: raw.verification_error,
  createdAt: raw.created_at,
});

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
    if (res.status === 204) {
      return undefined as T;
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

    domains: {
      /** Add a sending domain on the project's default carrier. `POST /v1/domains`. */
      async create(input: { name: string }): Promise<Domain> {
        const raw = await request<WireDomain>("POST", "/v1/domains", { body: { name: input.name } });
        return fromWireDomain(raw);
      },

      /** List the project's domains. `GET /v1/domains`. */
      async list(): Promise<{ data: Domain[] }> {
        const raw = await request<{ data: WireDomain[] }>("GET", "/v1/domains");
        return { data: raw.data.map(fromWireDomain) };
      },

      /** Fetch one domain, its records, and verification status. `GET /v1/domains/:id`. */
      async get(id: string): Promise<Domain> {
        const raw = await request<WireDomain>("GET", `/v1/domains/${encodeURIComponent(id)}`);
        return fromWireDomain(raw);
      },

      /** Re-check verification now. `POST /v1/domains/:id/verify`. */
      async verify(id: string): Promise<Domain> {
        const raw = await request<WireDomain>("POST", `/v1/domains/${encodeURIComponent(id)}/verify`);
        return fromWireDomain(raw);
      },

      /** Remove a domain. `DELETE /v1/domains/:id` → 204, no body. */
      remove(id: string): Promise<void> {
        return request<void>("DELETE", `/v1/domains/${encodeURIComponent(id)}`);
      },
    },
  };
}

export type Mailroom = ReturnType<typeof createMailroom>;
