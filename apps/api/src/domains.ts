import type { Carrier as CarrierRow, DomainStatus, Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { carrierFor } from "./carriers/index.js";
import type { DnsRecord, SenderIdentity } from "./carriers/types.js";

/**
 * Mailroom-managed sending domains (spec docs/specs/domains.md).
 *
 * One module behind the public routes, the admin routes and the poller, so the
 * provisioning rules live in exactly one place. Provider specifics stay in
 * `carriers/` — this file only ever asks a carrier whether it implements
 * `domains`, never what type it is.
 */

/** How long a domain may sit unverified before verification is abandoned (Resend uses the same window). */
export const VERIFICATION_WINDOW_MS = 72 * 3600 * 1000;

export const EXPIRED_MESSAGE = "verification window expired (72h); re-verify to restart";

/** Thrown by the service, mapped straight onto `{ error: "<code>", ... }` by the routes. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "DomainError";
  }
}

const domainWithCarrier = {
  carrier: { select: { id: true, name: true, type: true } },
} satisfies Prisma.DomainInclude;

export type DomainWithCarrier = Prisma.DomainGetPayload<{ include: typeof domainWithCarrier }>;

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Lowercase, trimmed, no trailing dot. Rejects anything that is not a plain
 * hostname with at least two labels: URLs, addresses, wildcards, underscores.
 */
export function normalizeDomainName(input: unknown): string {
  if (typeof input !== "string") throw new DomainError(400, "invalid_domain");
  const name = input.trim().toLowerCase().replace(/\.$/, "");
  if (!name || name.length > 253) throw new DomainError(400, "invalid_domain");
  if (name.includes("://") || name.includes("@") || name.includes("*") || name.includes("/")) {
    throw new DomainError(400, "invalid_domain");
  }
  if (/\s/.test(name)) throw new DomainError(400, "invalid_domain");
  const labels = name.split(".");
  if (labels.length < 2) throw new DomainError(400, "invalid_domain");
  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL.test(label)) throw new DomainError(400, "invalid_domain");
  }
  // A TLD is never all-numeric and is at least two characters.
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || !/^[a-z]+$/.test(tld)) throw new DomainError(400, "invalid_domain");
  return name;
}

// ---------------------------------------------------------------------------
// Wire shape (§3)
// ---------------------------------------------------------------------------

function readRecords(value: Prisma.JsonValue): DnsRecord[] {
  return Array.isArray(value) ? (value as unknown as DnsRecord[]) : [];
}

/**
 * The domain's own sender list, stored opaquely. Nothing here interprets an
 * entry — what a `username` means, and how `Support <support@x.com>` reduces
 * to a local part, is the provisioner's business (CLAUDE.md); this file only
 * carries the list from the row to the carrier and back onto the wire.
 */
function readSenders(value: Prisma.JsonValue): SenderIdentity[] {
  return Array.isArray(value) ? (value as unknown as SenderIdentity[]) : [];
}

/** The public/admin JSON for a domain. snake_case, lower-cased enums (D-05). */
export function toPublicDomain(d: DomainWithCarrier) {
  return {
    id: d.id,
    name: d.name,
    status: d.status.toLowerCase(),
    carrier: { id: d.carrier.id, name: d.carrier.name, type: d.carrier.type },
    project_id: d.projectId,
    mail_from_domain: d.mailFromDomain,
    records: readRecords(d.dnsRecords).map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority ?? null,
      ttl: r.ttl ?? null,
      purpose: String(r.purpose).toLowerCase(),
      required: r.required,
      status: String(r.status).toLowerCase(),
      note: r.note ?? null,
    })),
    sender_usernames: readSenders(d.senderUsernames),
    verified_at: d.verifiedAt,
    last_checked_at: d.lastCheckedAt,
    verification_error: d.verificationError,
    created_at: d.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateDomainInput {
  name: string;
  projectId?: string | null;
  /** Admin only; public callers always get the default carrier. */
  carrierId?: string | null;
  fallbackCarrierId?: string | null;
  notes?: string | null;
  /**
   * The addresses this domain may send as. Admin only — the public route never
   * offers it, because the list is an operator decision about the provider
   * account, not something an API key should be able to widen.
   */
  senderUsernames?: SenderIdentity[];
}

async function resolveCarrier(carrierId?: string | null): Promise<CarrierRow> {
  if (carrierId) {
    const row = await prisma.carrier.findUnique({ where: { id: carrierId } });
    if (!row) throw new DomainError(404, "carrier_not_found");
    // Same rejection an unset/disabled default carrier gets: a disabled
    // carrier must never provision a domain, explicit choice or not.
    if (!row.enabled) throw new DomainError(409, "no_default_carrier");
    return row;
  }
  const row = await prisma.carrier.findFirst({
    where: { isDefault: true, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  if (!row) throw new DomainError(409, "no_default_carrier");
  return row;
}

/** Per-project cap on the number of domains a single project may register. */
const MAX_DOMAINS_PER_PROJECT = 20;

export async function createDomain(input: CreateDomainInput): Promise<DomainWithCarrier> {
  const name = normalizeDomainName(input.name);
  const carrierRow = await resolveCarrier(input.carrierId);
  const carrier = carrierFor(carrierRow);

  const existing = await prisma.domain.findUnique({ where: { name }, select: { id: true } });
  if (existing) throw new DomainError(409, "domain_exists", { domain: name });

  if (input.projectId != null) {
    const count = await prisma.domain.count({ where: { projectId: input.projectId } });
    if (count >= MAX_DOMAINS_PER_PROJECT) throw new DomainError(409, "domain_limit_reached");
  }

  let data: Prisma.DomainUncheckedCreateInput = {
    name,
    projectId: input.projectId ?? null,
    carrierId: carrierRow.id,
    fallbackCarrierId: input.fallbackCarrierId ?? null,
    notes: input.notes ?? null,
    status: "VERIFIED",
    dnsRecords: [],
    senderUsernames: (input.senderUsernames ?? []) as unknown as Prisma.InputJsonValue,
    mailFromDomain: null,
    verifiedAt: new Date(),
  };

  if (carrier.domains) {
    // The provider decides its own MAIL FROM domain (SES wants `send.<domain>`,
    // ACS the domain itself) — this file never learns which carrier it has.
    const mailFromDomain = carrier.domains.mailFromFor(name);
    let records: DnsRecord[];
    try {
      ({ records } = await carrier.domains.createDomain(name, { mailFromDomain }));
    } catch (err) {
      // The row is never created when the provider refuses — otherwise the
      // dashboard shows a domain that exists nowhere upstream.
      const detail = err instanceof Error ? err.message : String(err);
      logger.error({ domain: name, carrier: carrierRow.name, err: detail }, "domain provisioning failed");
      throw new DomainError(502, "provider_error", { message: detail.slice(0, 500) });
    }
    data = {
      ...data,
      status: "PENDING",
      dnsRecords: records as unknown as Prisma.InputJsonValue,
      mailFromDomain,
      verifiedAt: null,
    };
  }

  try {
    return await prisma.domain.create({ data, include: domainWithCarrier });
  } catch (err) {
    // Lost a race against a concurrent create.
    if ((err as { code?: string }).code === "P2002") {
      throw new DomainError(409, "domain_exists", { domain: name });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Check / verify
// ---------------------------------------------------------------------------

/**
 * A domain whose DNS is never published must not poll forever. Applied to the
 * freshly reported status, so a domain that verified on this very call is
 * never expired out from under the user.
 */
export function applyExpiry(
  status: DomainStatus,
  createdAt: Date,
  error: string | null,
  now: Date = new Date(),
): { status: DomainStatus; error: string | null } {
  if (status !== "PENDING" && status !== "TEMPORARY_FAILURE") return { status, error };
  if (now.getTime() - createdAt.getTime() <= VERIFICATION_WINDOW_MS) return { status, error };
  return { status: "FAILED", error: EXPIRED_MESSAGE };
}

export async function checkDomain(id: string): Promise<DomainWithCarrier> {
  const domain = await prisma.domain.findUnique({ where: { id }, include: domainWithCarrier });
  if (!domain) throw new DomainError(404, "not_found");

  const carrierRow = await prisma.carrier.findUnique({ where: { id: domain.carrierId } });
  if (!carrierRow) throw new DomainError(404, "carrier_not_found");
  const carrier = carrierFor(carrierRow);
  if (!carrier.domains) return domain; // manual carrier — nothing to ask

  // Re-verifying a FAILED domain restarts the 72h window: this is how a user
  // recovers after publishing the records late, matching Resend.
  const restarted = domain.status === "FAILED";
  const createdAt = restarted ? new Date() : domain.createdAt;
  const mailFromDomain = domain.mailFromDomain ?? carrier.domains.mailFromFor(domain.name);

  // The sender list rides along on every check: registering it is a side
  // effect of verification (see `DomainProvisioner.checkDomain`), and this is
  // also the path an edit to the list is pushed through.
  const result = await carrier.domains.checkDomain(domain.name, {
    mailFromDomain,
    senders: readSenders(domain.senderUsernames),
  });
  const expired = applyExpiry(result.status, createdAt, result.error ?? null);

  // A provider blip must not un-verify a domain that is already sending. The
  // poller never reaches a VERIFIED domain, so a check on one only happens on
  // a manual re-verify or a sender-list edit — and there, reporting
  // TEMPORARY_FAILURE would take the domain out of the D-07 send gate until
  // the next sweep recovers it. Editing a display name must not stop mail.
  const wouldRegress = domain.status === "VERIFIED" && expired.status === "TEMPORARY_FAILURE";
  const status = wouldRegress ? "VERIFIED" : expired.status;
  const error = wouldRegress ? null : expired.error;
  if (wouldRegress) {
    logger.warn(
      { domain: domain.name, err: expired.error },
      "provider check failed transiently on a verified domain; keeping VERIFIED",
    );
  }

  const data: Prisma.DomainUncheckedUpdateInput = {
    status,
    lastCheckedAt: new Date(),
    verificationError: status === "VERIFIED" ? null : error,
  };
  // A not-found check comes back with no records; keep the ones we issued
  // rather than blanking the DNS table the user is working from.
  if (result.records.length) data.dnsRecords = result.records as unknown as Prisma.InputJsonValue;
  if (status === "VERIFIED" && !domain.verifiedAt) data.verifiedAt = new Date();
  if (restarted) data.createdAt = createdAt;

  return prisma.domain.update({ where: { id }, data, include: domainWithCarrier });
}

// ---------------------------------------------------------------------------
// Reprovision (move an existing domain to another carrier)
// ---------------------------------------------------------------------------

/**
 * Move `id` onto `carrierId` and register it there.
 *
 * The row keeps its id, so every `Message` already logged against the domain
 * stays attached — which is the whole point: `deleteDomain` refuses a domain
 * that has sent mail, so delete-and-recreate is not a migration path for a
 * live domain.
 *
 * Order matters. The target provider is asked first and the row is left
 * untouched if it refuses (same rule as `createDomain`: never point the
 * dashboard at a carrier that has no identity for the domain). The old
 * provider is only cleaned up once the new state is committed, best effort —
 * a stale identity upstream is not worth failing or reverting a migration for.
 */
export async function reprovisionDomain(id: string, carrierId: string): Promise<DomainWithCarrier> {
  const domain = await prisma.domain.findUnique({ where: { id }, include: domainWithCarrier });
  if (!domain) throw new DomainError(404, "not_found");

  // Explicit target only. `resolveCarrier` falls back to the platform default
  // for an empty id, and a migration must never guess where it is going.
  if (!carrierId) throw new DomainError(404, "carrier_not_found");
  const targetRow = await resolveCarrier(carrierId);

  // Already there: idempotent, and no provider is touched. Re-registering
  // would reissue DKIM records and drop a working domain back to PENDING.
  if (targetRow.id === domain.carrierId) return domain;

  const target = carrierFor(targetRow);

  let data: Prisma.DomainUncheckedUpdateInput = {
    carrierId: targetRow.id,
    // Manual carrier (no `domains`): nothing upstream to verify, same terms a
    // domain created on it would get.
    status: "VERIFIED",
    dnsRecords: [],
    mailFromDomain: null,
    verifiedAt: new Date(),
    verificationError: null,
  };

  if (target.domains) {
    const mailFromDomain = target.domains.mailFromFor(domain.name);
    let records: DnsRecord[];
    try {
      ({ records } = await target.domains.createDomain(domain.name, { mailFromDomain }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(
        { domain: domain.name, carrier: targetRow.name, err: detail },
        "domain reprovisioning failed; carrier not moved",
      );
      throw new DomainError(502, "provider_error", { message: detail.slice(0, 500) });
    }
    data = {
      ...data,
      status: "PENDING",
      dnsRecords: records as unknown as Prisma.InputJsonValue,
      mailFromDomain,
      verifiedAt: null,
      // Nothing has been checked against the *new* carrier yet; keeping the old
      // carrier's timestamp would read as "checked just now" in the dashboard.
      lastCheckedAt: null,
      // The 72h window starts again from this move, not from the original
      // registration — otherwise an old domain expires on its first sweep.
      createdAt: new Date(),
    };
  }

  const updated = await prisma.domain.update({ where: { id }, data, include: domainWithCarrier });
  logger.info(
    { domain: domain.name, from: domain.carrier.name, to: targetRow.name, status: updated.status },
    "domain reprovisioned onto a new carrier",
  );

  // Last, and never fatal: the row is already on the new carrier.
  const previousRow = await prisma.carrier.findUnique({ where: { id: domain.carrierId } });
  if (previousRow) {
    const previous = carrierFor(previousRow);
    if (previous.domains) {
      try {
        await previous.domains.deleteDomain(domain.name);
      } catch (err) {
        logger.warn(
          {
            domain: domain.name,
            carrier: previousRow.name,
            err: err instanceof Error ? err.message : String(err),
          },
          "old carrier identity delete failed; domain already moved",
        );
      }
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteDomain(id: string): Promise<void> {
  const domain = await prisma.domain.findUnique({ where: { id }, include: domainWithCarrier });
  if (!domain) throw new DomainError(404, "not_found");

  // Message.domainId is a required FK — deleting the domain would orphan the
  // log, so refuse rather than cascade.
  const inUse = await prisma.message.count({ where: { domainId: id } });
  if (inUse > 0) throw new DomainError(409, "domain_in_use", { messages: inUse });

  const carrierRow = await prisma.carrier.findUnique({ where: { id: domain.carrierId } });
  if (carrierRow) {
    const carrier = carrierFor(carrierRow);
    if (carrier.domains) {
      // Best effort: a stale provider identity is not a reason to keep the row.
      try {
        await carrier.domains.deleteDomain(domain.name);
      } catch (err) {
        logger.warn(
          { domain: domain.name, err: err instanceof Error ? err.message : String(err) },
          "provider identity delete failed; removing row anyway",
        );
      }
    }
  }

  await prisma.domain.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Poller (§7)
// ---------------------------------------------------------------------------

/**
 * Re-check every domain still waiting on DNS. Sequential on purpose: SES API
 * limits are modest and there are never many of these. One failure never
 * aborts the batch.
 */
export async function verifyPendingDomains(): Promise<{ checked: number; verified: number; failed: number }> {
  const pending = await prisma.domain.findMany({
    where: { status: { in: ["PENDING", "TEMPORARY_FAILURE"] } },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let checked = 0;
  let verified = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      const updated = await checkDomain(row.id);
      checked += 1;
      if (updated.status === "VERIFIED") verified += 1;
      if (updated.status === "FAILED") failed += 1;
      logger.info(
        { domain: row.name, status: updated.status, error: updated.verificationError },
        "domain verification checked",
      );
    } catch (err) {
      logger.warn(
        { domain: row.name, err: err instanceof Error ? err.message : String(err) },
        "domain verification check failed",
      );
    }
  }
  if (pending.length) logger.info({ checked, verified, failed }, "domain-verify sweep complete");
  return { checked, verified, failed };
}
