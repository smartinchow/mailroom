import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import type { DomainStatus } from "@prisma/client";
import type { AcsArmConfig, DnsRecord, DomainProvisioner } from "./types.js";

/**
 * ACS domain provisioning over Azure Resource Manager.
 *
 * ACS has no SDK for the management plane that is worth a dependency here, so
 * this talks raw ARM REST through an injectable fetch — which is also how the
 * tests avoid the network without a mocking library (mirrors `ses.ts`).
 *
 * Facts that are easy to get wrong:
 * - ACS has NO custom MAIL FROM subdomain. Its SPF record is a TXT on the
 *   sending domain itself, so `mailFromFor` is the identity function and the
 *   SES `send.<domain>` convention must never be applied here.
 * - `verificationRecords` names are RELATIVE to the domain
 *   (`selector1-azurecomm-prod-net._domainkey`), while `DnsRecord.name` is
 *   documented fully qualified — qualify before returning.
 * - Domain ownership must be `Verified` before SPF/DKIM/DKIM2 verification can
 *   even be started, so `checkDomain` drives that ordering on every poll.
 * - `linkedDomains` on the Communication Service is a WHOLE-ARRAY replace.
 *   Always read-modify-write, or the PATCH silently unlinks every other live
 *   sending domain on the resource.
 * - ACS's stock SPF value is `-all`. A domain may hold only ONE SPF record, so
 *   handing that to an owner who already sends mail replaces their record and
 *   hard-fails every other sender they have. `planSpfRecord` resolves what is
 *   already published and merges instead (see `mergeSpf`).
 */

const ARM_BASE = "https://management.azure.com";
const API_VERSION = "2023-04-01";
const LOGIN_BASE = "https://login.microsoftonline.com";
const ARM_SCOPE = "https://management.azure.com/.default";

/** Long-running operations: bounded so a stuck ARM operation never wedges the poller. */
const LRO_MAX_ATTEMPTS = 20;
const LRO_DELAY_MS = 1500;

/** Refresh the ARM token this far before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Sender usernames created once the domain verifies. ACS refuses a send from
 * an address whose username is not registered on the domain, so provisioning
 * one is part of making the domain usable. `donotreply` is the ACS default and
 * `noreply` is the house convention (docs/DESIGN.md).
 */
const SENDER_USERNAMES: { username: string; displayName: string }[] = [
  { username: "noreply", displayName: "No Reply" },
  { username: "donotreply", displayName: "Do Not Reply" },
];

/** The four verification types ACS reports records for, in publish order. */
const RECORD_KEYS = ["Domain", "SPF", "DKIM", "DKIM2"] as const;
type RecordKey = (typeof RECORD_KEYS)[number];

/** ACS `verificationStates[*].status` vocabulary. */
type AcsVerificationStatus =
  | "NotStarted"
  | "VerificationRequested"
  | "VerificationInProgress"
  | "VerificationFailed"
  | "Verified"
  | "CancellationRequested";

interface AcsVerificationRecord {
  type?: string;
  name?: string;
  value?: string;
  ttl?: number;
}

interface AcsDomainResource {
  properties?: {
    verificationRecords?: Partial<Record<RecordKey, AcsVerificationRecord>>;
    verificationStates?: Partial<Record<string, { status?: string; errorCode?: string }>>;
  };
}

// ---------------------------------------------------------------------------
// Injectable transport
// ---------------------------------------------------------------------------

/** The slice of `Response` this module uses, so a plain object can stand in. */
export interface ArmResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ArmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ArmResponse>;

export interface AcsDomainProvisionerDeps {
  /** Injected in tests so no Azure call is ever made. Defaults to global fetch. */
  fetch?: ArmFetch;
  /** Injected in tests so LRO polling costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to drive token expiry. */
  now?: () => number;
  /** Injected in tests; defaults to node:dns/promises resolveTxt (mirrors `ses.ts`). */
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}

/** An ARM call that came back non-2xx. `transient` drives TEMPORARY_FAILURE. */
class ArmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ArmError";
  }

  /** Throttling and server faults are Azure's problem, not the record owner's. */
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof ArmError && err.status === 404;
}

// ---------------------------------------------------------------------------
// SPF merge
// ---------------------------------------------------------------------------

/**
 * ACS's stock SPF value is always `v=spf1 include:spf.protection.outlook.com -all`.
 * A domain may publish only ONE SPF record, so telling an owner who already
 * sends mail to publish that verbatim replaces their record and, because of the
 * `-all`, hard-fails every other sender they have. Merge instead.
 *
 * Deliberately NOT checked here: the SPF 10-DNS-lookup limit. Out of scope.
 */

/** The include ACS needs. Fixed by the provider, hence a constant. */
const ACS_SPF_INCLUDE = "include:spf.protection.outlook.com";

/** SPF version term. Matched case-insensitively — records in the wild shout. */
const SPF_PREFIX = "v=spf1";

/** `all` carrying any qualifier: the mechanism the include goes in front of. */
const ALL_MECHANISM = /^[+\-~?]?all$/i;

/** ACS's include, with or without an explicit qualifier (`+include:` is an include). */
const ACS_INCLUDE_MECHANISM = /^[+\-~?]?include:spf\.protection\.outlook\.com$/i;

/**
 * Fold ACS's include into an SPF record that is already published.
 *
 * The include is inserted immediately BEFORE the trailing `all`, whose
 * qualifier is copied through untouched — promoting a `~all` to `-all` would
 * start bouncing the owner's existing mail, which is the exact harm this
 * function exists to prevent. A record with no `all` (a `redirect=` record, or
 * a bare `v=spf1`) gets the include appended, since anything else would
 * reorder terms whose meaning we cannot see.
 *
 * Pure and exported so it can be unit-tested with no transport at all.
 */
export function mergeSpf(existing: string): string {
  const trimmed = existing.trim();
  const tokens = trimmed.split(/\s+/);
  // Already satisfied — the owner must not be told to change anything.
  if (tokens.some((t) => ACS_INCLUDE_MECHANISM.test(t))) return trimmed;

  // Last `all`, never the version term at index 0.
  let at = -1;
  for (let i = tokens.length - 1; i > 0; i -= 1) {
    if (ALL_MECHANISM.test(tokens[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) return [...tokens, ACS_SPF_INCLUDE].join(" ");
  tokens.splice(at, 0, ACS_SPF_INCLUDE);
  return tokens.join(" ");
}

/** The SPF record's final value, plus the operator-facing `note` explaining it. */
export interface SpfPlan {
  value: string;
  note?: string;
}

/**
 * Decide what to actually put in the SPF record, given ACS's stock value and
 * whatever the domain publishes today. Never throws: a resolver blip must not
 * fail a provisioning call, but it also must not masquerade as "no existing
 * record" — that case carries a warning note instead.
 */
export async function planSpfRecord(
  domain: string,
  stock: string,
  resolveTxt: (hostname: string) => Promise<string[][]>,
): Promise<SpfPlan> {
  let answers: string[][];
  try {
    answers = await resolveTxt(domain);
  } catch (err) {
    // NXDOMAIN / no TXT records is a definitive answer, not a failure: the
    // domain provably has no SPF record, which is the ordinary greenfield
    // case for a subdomain that does not exist yet. Warning there would fire
    // on most new domains and teach operators to ignore the one note that
    // matters. Only an inconclusive lookup (SERVFAIL, timeout, refused)
    // leaves us genuinely unable to tell, and that is what deserves a note.
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { value: stock };
    return {
      value: stock,
      note: "Could not read this domain's existing SPF record (DNS lookup failed). If one is already published, merge this include into it instead of replacing it.",
    };
  }

  // A TXT answer arrives as chunks split at 255 chars; they join with nothing
  // between them. A domain also holds plenty of TXT records that are not SPF.
  const found = answers
    .map((chunks) => chunks.join("").trim())
    .filter((txt) => txt.toLowerCase().startsWith(SPF_PREFIX));

  if (found.length === 0) return { value: stock }; // greenfield
  if (found.length > 1) {
    // Two SPF records is already a PermError. Merging one of them would only
    // hide that, so hand back the stock value and say so.
    return {
      value: stock,
      note: "This domain publishes more than one SPF record, which already fails SPF (PermError). Remove the duplicates first, then merge this include into the one that remains.",
    };
  }

  const existing = found[0];
  const merged = mergeSpf(existing);
  if (merged === existing) {
    return {
      value: existing,
      note: "This domain's existing SPF record already authorises ACS. It is shown verbatim — publish it unchanged.",
    };
  }
  return {
    value: merged,
    note: "Merged with the SPF record already published on this domain. Replace that record with this value wholesale — a domain may hold only one SPF record.",
  };
}

// ---------------------------------------------------------------------------
// Record mapping
// ---------------------------------------------------------------------------

/** ARM verification key → the `DnsRecord.purpose` the wire uses. */
const PURPOSE: Record<RecordKey, DnsRecord["purpose"]> = {
  Domain: "DOMAIN_OWNERSHIP",
  SPF: "MAIL_FROM_SPF",
  DKIM: "DKIM",
  DKIM2: "DKIM",
};

function recordType(raw: string | undefined): DnsRecord["type"] {
  const upper = String(raw ?? "TXT").toUpperCase();
  return upper === "CNAME" || upper === "MX" ? upper : "TXT";
}

/**
 * ACS returns names relative to the domain (and `@`/empty for the apex).
 * `DnsRecord.name` is fully qualified with no trailing dot.
 */
export function qualify(name: string | undefined, domain: string): string {
  const trimmed = String(name ?? "").trim().replace(/\.$/, "");
  if (!trimmed || trimmed === "@") return domain;
  if (trimmed === domain || trimmed.endsWith(`.${domain}`)) return trimmed;
  return `${trimmed}.${domain}`;
}

/** Per-record status. Anything mid-flight reads PENDING; only ACS `NotStarted` is NOT_STARTED. */
function recordStatus(status: AcsVerificationStatus | undefined): DnsRecord["status"] {
  switch (status) {
    case "Verified":
      return "VERIFIED";
    case "VerificationFailed":
      return "FAILED";
    case "NotStarted":
    case undefined:
      return "NOT_STARTED";
    default:
      // VerificationRequested, VerificationInProgress, CancellationRequested.
      return "PENDING";
  }
}

function stateOf(res: AcsDomainResource, key: string): AcsVerificationStatus | undefined {
  const raw = res.properties?.verificationStates?.[key]?.status;
  return raw ? (raw as AcsVerificationStatus) : undefined;
}

/**
 * Map ACS's `verificationRecords` onto `DnsRecord[]`. All four are required —
 * ACS will not sign, and therefore will not send, until every one is verified.
 * DMARC is deliberately absent: ACS neither issues nor checks it.
 *
 * `spf`, when given, overrides ACS's stock SPF value with the merged one from
 * `planSpfRecord`. It is a parameter rather than a lookup so this stays pure.
 */
export function buildRecords(domain: string, res: AcsDomainResource, spf?: SpfPlan): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (const key of RECORD_KEYS) {
    const raw = res.properties?.verificationRecords?.[key];
    if (!raw?.value) continue;
    const override = key === "SPF" ? spf : undefined;
    const record: DnsRecord = {
      type: recordType(raw.type),
      name: qualify(raw.name, domain),
      value: override?.value ?? raw.value,
      ttl: raw.ttl ?? 3600,
      purpose: PURPOSE[key],
      required: true,
      status: recordStatus(stateOf(res, key)),
    };
    if (override?.note) record.note = override.note;
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

const defaultFetch: ArmFetch = (url, init) => globalThis.fetch(url, init);

export function createAcsDomainProvisioner(
  arm: AcsArmConfig,
  deps: AcsDomainProvisionerDeps = {},
): DomainProvisioner {
  const doFetch = deps.fetch ?? defaultFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const resolveTxt = deps.resolveTxt ?? dnsResolveTxt;

  /** Cached client-credentials token. Never logged, never returned. */
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - TOKEN_SKEW_MS > now()) return token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: arm.clientId,
      client_secret: arm.clientSecret,
      scope: ARM_SCOPE,
    }).toString();
    const res = await doFetch(`${LOGIN_BASE}/${arm.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // The response body can echo the request; never surface it, it may carry
      // the client secret back.
      throw new ArmError(res.status, "token_request_failed", `ARM token request failed (${res.status})`);
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new ArmError(500, "token_request_failed", "ARM token response had no access_token");
    token = { value: parsed.access_token, expiresAt: now() + (parsed.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  /** One authenticated ARM call. Returns the parsed body plus the raw response. */
  async function call(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: any; headers: ArmResponse["headers"] }> {
    const bearer = await accessToken();
    const res = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = parsed?.error ?? {};
      throw new ArmError(
        res.status,
        err.code ? String(err.code) : undefined,
        `ARM ${method} failed (${res.status}${err.code ? ` ${String(err.code)}` : ""}): ${
          err.message ? String(err.message) : text.slice(0, 300)
        }`,
      );
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const prefix = `${ARM_BASE}/subscriptions/${arm.subscriptionId}/resourceGroups/${arm.resourceGroup}/providers/Microsoft.Communication`;

  /** The domain's ARM resource id — also the value that goes into `linkedDomains`. */
  function domainId(name: string): string {
    return `/subscriptions/${arm.subscriptionId}/resourceGroups/${arm.resourceGroup}/providers/Microsoft.Communication/emailServices/${arm.emailServiceName}/domains/${name}`;
  }

  function domainUrl(name: string, suffix = ""): string {
    return `${prefix}/emailServices/${arm.emailServiceName}/domains/${name}${suffix}?api-version=${API_VERSION}`;
  }

  const acsUrl = `${prefix}/communicationServices/${arm.communicationServiceName}?api-version=${API_VERSION}`;

  /**
   * Follow an `Azure-AsyncOperation` header to completion. Bounded: an
   * operation still running when the attempts run out is left to the next
   * poll rather than blocking a worker forever.
   */
  async function awaitLro(headers: ArmResponse["headers"]): Promise<void> {
    const url = headers.get("azure-asyncoperation") ?? headers.get("Azure-AsyncOperation");
    if (!url) return;
    for (let attempt = 0; attempt < LRO_MAX_ATTEMPTS; attempt += 1) {
      await sleep(LRO_DELAY_MS);
      const { body } = await call("GET", url);
      const status = String(body?.status ?? "");
      if (status === "Succeeded") return;
      if (status === "Failed" || status === "Canceled") {
        const err = body?.error ?? {};
        throw new ArmError(
          400,
          err.code ? String(err.code) : undefined,
          `ARM operation ${status}: ${err.message ? String(err.message) : "no detail"}`,
        );
      }
    }
  }

  async function getDomain(name: string): Promise<AcsDomainResource> {
    const { body } = await call("GET", domainUrl(name));
    return (body ?? {}) as AcsDomainResource;
  }

  /**
   * `buildRecords` plus the SPF merge, which needs the injected resolver and so
   * cannot live in the pure mapper.
   */
  async function recordsFor(name: string, res: AcsDomainResource): Promise<DnsRecord[]> {
    const stock = res.properties?.verificationRecords?.SPF?.value;
    const spf = stock ? await planSpfRecord(name, stock, resolveTxt) : undefined;
    return buildRecords(name, res, spf);
  }

  /**
   * Start one verification. Never fatal: ACS rejects a type that is already
   * requested or whose prerequisite is unmet, and the next poll retries.
   */
  async function initiate(name: string, type: RecordKey): Promise<void> {
    try {
      const { headers } = await call("POST", domainUrl(name, "/initiateVerification"), {
        verificationType: type,
      });
      await awaitLro(headers);
    } catch {
      // Deliberately swallowed — checkDomain re-drives the state machine.
    }
  }

  /**
   * Add this domain to the Communication Service's `linkedDomains`, preserving
   * everything already there. The PATCH replaces the entire array, so a blind
   * write would unlink every other live sender on the resource.
   */
  async function link(name: string): Promise<void> {
    const id = domainId(name);
    const { body } = await call("GET", acsUrl);
    const current: string[] = Array.isArray(body?.properties?.linkedDomains)
      ? body.properties.linkedDomains.map(String)
      : [];
    if (current.some((d) => d.toLowerCase() === id.toLowerCase())) return; // already linked
    await call("PATCH", acsUrl, { properties: { linkedDomains: [...current, id] } });
  }

  /** Inverse of `link`: drop only our own entry from the fetched list. */
  async function unlink(name: string): Promise<void> {
    const id = domainId(name).toLowerCase();
    const { body } = await call("GET", acsUrl);
    const current: string[] = Array.isArray(body?.properties?.linkedDomains)
      ? body.properties.linkedDomains.map(String)
      : [];
    const remaining = current.filter((d) => d.toLowerCase() !== id);
    if (remaining.length === current.length) return; // not linked
    await call("PATCH", acsUrl, { properties: { linkedDomains: remaining } });
  }

  /** PUT is an upsert, so this is safe to repeat on every later check. */
  async function ensureSenderUsernames(name: string): Promise<void> {
    for (const sender of SENDER_USERNAMES) {
      const { headers } = await call("PUT", domainUrl(name, `/senderUsernames/${sender.username}`), {
        properties: { username: sender.username, displayName: sender.displayName },
      });
      await awaitLro(headers);
    }
  }

  return {
    // ACS publishes SPF on the sending domain itself — there is no custom
    // MAIL FROM subdomain to align against.
    mailFromFor(name) {
      return name;
    },

    async createDomain(name) {
      // PUT is an upsert: a domain that already exists is updated in place and
      // still hands back its records, which is exactly the idempotency the
      // contract asks for.
      const { headers } = await call("PUT", domainUrl(name), {
        location: "global",
        properties: { domainManagement: "CustomerManaged", userEngagementTracking: "Disabled" },
      });
      await awaitLro(headers);

      // Ownership is the gate on everything else, so start it immediately —
      // the user publishes the TXT while the 5-minute poller waits.
      await initiate(name, "Domain");

      const resource = await getDomain(name);
      return { records: await recordsFor(name, resource) };
    },

    async checkDomain(name) {
      let resource: AcsDomainResource;
      try {
        resource = await getDomain(name);
      } catch (err) {
        if (isNotFound(err)) {
          return { status: "FAILED" as DomainStatus, records: [], error: "domain not found at provider" };
        }
        if (err instanceof ArmError && err.transient) {
          // `applyExpiry` treats TEMPORARY_FAILURE as still-polling, so an ARM
          // outage must never be reported as a record the user got wrong.
          return { status: "TEMPORARY_FAILURE" as DomainStatus, records: [], error: err.message };
        }
        throw err;
      }

      const states = Object.fromEntries(
        RECORD_KEYS.map((key) => [key, stateOf(resource, key)]),
      ) as Record<RecordKey, AcsVerificationStatus | undefined>;

      // ACS refuses SPF/DKIM/DKIM2 verification until ownership is proven, so
      // the state machine is driven one step per poll from here. `initiate`
      // never throws: a rejected start is retried on the next sweep.
      if (states.Domain === "NotStarted" || states.Domain === undefined) {
        await initiate(name, "Domain");
      } else if (states.Domain === "Verified") {
        for (const key of ["SPF", "DKIM", "DKIM2"] as const) {
          if (states[key] === "NotStarted" || states[key] === undefined) await initiate(name, key);
        }
      }

      const records = await recordsFor(name, resource);

      const failed = RECORD_KEYS.filter((key) => states[key] === "VerificationFailed");
      if (failed.length) {
        const error = failed
          .map((key) => {
            const code = resource.properties?.verificationStates?.[key]?.errorCode;
            return code ? `${key} verification failed (${code})` : `${key} verification failed`;
          })
          .join("; ");
        return { status: "FAILED" as DomainStatus, records, error };
      }

      if (RECORD_KEYS.every((key) => states[key] === "Verified")) {
        // Both steps are idempotent, so repeating them on a later check of an
        // already-verified domain is harmless.
        try {
          await ensureSenderUsernames(name);
          await link(name);
        } catch (err) {
          if (err instanceof ArmError && err.transient) {
            return { status: "TEMPORARY_FAILURE" as DomainStatus, records, error: err.message };
          }
          throw err;
        }
        return { status: "VERIFIED" as DomainStatus, records };
      }

      return { status: "PENDING" as DomainStatus, records };
    },

    async deleteDomain(name) {
      // Unlink first: ARM refuses to delete a domain still linked to the
      // Communication Service.
      try {
        await unlink(name);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      try {
        const { headers } = await call("DELETE", domainUrl(name));
        await awaitLro(headers);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}
