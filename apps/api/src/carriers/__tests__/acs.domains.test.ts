import { describe, expect, it } from "vitest";
import { createAcsDomainProvisioner, mergeSpf } from "../acs-domains.js";
import type { AcsArmConfig, DnsRecord } from "../types.js";

/**
 * ACS domain provisioning against an injected fake ARM transport — no Azure
 * call is ever made, and no mocking library is needed (mirrors
 * ses.domains.test.ts). Sleep is stubbed out so LRO polling is instant.
 */

const ARM: AcsArmConfig = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "shhh",
  subscriptionId: "sub-1",
  resourceGroup: "rg-amlify-email",
  emailServiceName: "amlify-email",
  communicationServiceName: "amlify-acs",
};

const DOMAIN = "example.com";

const DOMAIN_ID =
  "/subscriptions/sub-1/resourceGroups/rg-amlify-email/providers/Microsoft.Communication/emailServices/amlify-email/domains/example.com";

/** A live production sender that must survive every linkedDomains write. */
const EXISTING_LINKED = [
  "/subscriptions/sub-1/resourceGroups/rg-amlify-email/providers/Microsoft.Communication/emailServices/amlify-email/domains/tx.amlify.au",
  "/subscriptions/sub-1/resourceGroups/rg-amlify-email/providers/Microsoft.Communication/emailServices/amlify-email/domains/email.amlify.au",
];

const VERIFICATION_RECORDS = {
  Domain: { type: "TXT", name: "", value: "ms-domain-verification=abc123", ttl: 3600 },
  SPF: { type: "TXT", name: "", value: "v=spf1 include:spf.protection.outlook.com -all", ttl: 3600 },
  DKIM: {
    type: "CNAME",
    name: "selector1-azurecomm-prod-net._domainkey",
    value: "selector1-azurecomm-prod-net._domainkey.azurecomm.net",
    ttl: 3600,
  },
  DKIM2: {
    type: "CNAME",
    name: "selector2-azurecomm-prod-net._domainkey",
    value: "selector2-azurecomm-prod-net._domainkey.azurecomm.net",
    ttl: 3600,
  },
};

type State = "NotStarted" | "VerificationRequested" | "VerificationInProgress" | "VerificationFailed" | "Verified";

function states(domain: State, spf: State = "NotStarted", dkim: State = "NotStarted", dkim2: State = "NotStarted") {
  return {
    Domain: { status: domain },
    SPF: { status: spf },
    DKIM: { status: dkim },
    DKIM2: { status: dkim2 },
  };
}

function domainResource(verificationStates: Record<string, unknown>) {
  return { properties: { verificationRecords: VERIFICATION_RECORDS, verificationStates } };
}

// ---------------------------------------------------------------------------
// Fake ARM transport
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
  body: any;
}

interface Route {
  /** Matched against `<METHOD> <path-without-query>`; a substring is enough. */
  match: string;
  status?: number;
  /** Response body, or a function of the call. Returning an Error is not used here. */
  reply?: (call: Call) => unknown;
  headers?: Record<string, string>;
}

/** No TXT records published: the greenfield case, so SPF stays ACS's stock value. */
const noTxt = async () => [] as string[][];

function fakeArm(routes: Route[], resolveTxt: (h: string) => Promise<string[][]> = noTxt) {
  const calls: Call[] = [];
  const provisioner = createAcsDomainProvisioner(ARM, {
    sleep: async () => {},
    resolveTxt,
    async fetch(url, init) {
      const body = init.body ? tryParse(init.body) : undefined;
      // The token endpoint is form-encoded and answered for free; the secret
      // must never appear anywhere else.
      if (url.includes("login.microsoftonline.com")) {
        calls.push({ method: init.method, url, body: "<token-request>" });
        return response(200, { access_token: "bearer-token", expires_in: 3600 });
      }
      const path = url.split("?")[0];
      const key = `${init.method} ${path}`;
      calls.push({ method: init.method, url: path, body });
      for (const route of routes) {
        if (key.includes(route.match)) {
          return response(route.status ?? 200, route.reply ? route.reply({ method: init.method, url: path, body }) : {}, route.headers);
        }
      }
      throw new Error(`unexpected ARM call ${key}`);
    },
  });
  return { provisioner, calls };
}

function tryParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

const ARM_BASE = "https://management.azure.com";
const DOMAIN_PATH = `emailServices/amlify-email/domains/${DOMAIN}`;
const ACS_PATH = "communicationServices/amlify-acs";

function byPurpose(records: DnsRecord[], purpose: DnsRecord["purpose"]) {
  return records.filter((r) => r.purpose === purpose);
}

function armCalls(calls: Call[]) {
  return calls.filter((c) => !c.url.includes("login.microsoftonline.com"));
}

// ---------------------------------------------------------------------------
// mailFromFor
// ---------------------------------------------------------------------------

describe("mailFromFor", () => {
  it("is the domain itself — ACS has no custom MAIL FROM subdomain", () => {
    const { provisioner } = fakeArm([]);
    expect(provisioner.mailFromFor("example.com")).toBe("example.com");
    expect(provisioner.mailFromFor("mail.example.com")).toBe("mail.example.com");
  });
});

// ---------------------------------------------------------------------------
// createDomain
// ---------------------------------------------------------------------------

describe("createDomain", () => {
  const routes: Route[] = [
    { match: `PUT ${ARM_BASE}/subscriptions/sub-1`, reply: () => ({}) },
    { match: `POST ${ARM_BASE}`, reply: () => ({}) },
    { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("NotStarted")) },
  ];

  it("maps all four verification records and fully qualifies their names", async () => {
    const { provisioner } = fakeArm(routes);
    const { records } = await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });

    expect(records).toEqual([
      {
        type: "TXT",
        name: "example.com",
        value: "ms-domain-verification=abc123",
        ttl: 3600,
        purpose: "DOMAIN_OWNERSHIP",
        required: true,
        status: "NOT_STARTED",
      },
      {
        type: "TXT",
        name: "example.com",
        value: "v=spf1 include:spf.protection.outlook.com -all",
        ttl: 3600,
        purpose: "MAIL_FROM_SPF",
        required: true,
        status: "NOT_STARTED",
      },
      {
        type: "CNAME",
        name: "selector1-azurecomm-prod-net._domainkey.example.com",
        value: "selector1-azurecomm-prod-net._domainkey.azurecomm.net",
        ttl: 3600,
        purpose: "DKIM",
        required: true,
        status: "NOT_STARTED",
      },
      {
        type: "CNAME",
        name: "selector2-azurecomm-prod-net._domainkey.example.com",
        value: "selector2-azurecomm-prod-net._domainkey.azurecomm.net",
        ttl: 3600,
        purpose: "DKIM",
        required: true,
        status: "NOT_STARTED",
      },
    ]);
    // No DMARC record: ACS neither issues nor checks one.
    expect(byPurpose(records, "DMARC")).toEqual([]);
  });

  it("PUTs a CustomerManaged domain and kicks off Domain verification", async () => {
    const { provisioner, calls } = fakeArm(routes);
    await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });

    const put = armCalls(calls).find((c) => c.method === "PUT")!;
    expect(put.url).toContain(DOMAIN_PATH);
    expect(put.body).toEqual({
      location: "global",
      properties: { domainManagement: "CustomerManaged", userEngagementTracking: "Disabled" },
    });

    const post = armCalls(calls).find((c) => c.method === "POST")!;
    expect(post.url).toContain(`${DOMAIN_PATH}/initiateVerification`);
    expect(post.body).toEqual({ verificationType: "Domain" });
  });

  it("is idempotent: an existing domain returns its records instead of throwing", async () => {
    // ARM's PUT is an upsert, so an already-provisioned domain comes back with
    // its verification already in flight.
    const { provisioner } = fakeArm([
      { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
      { match: `POST ${ARM_BASE}`, status: 409, reply: () => ({ error: { code: "Conflict", message: "already requested" } }) },
      { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("VerificationRequested")) },
    ]);

    const { records } = await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(records).toHaveLength(4);
    expect(byPurpose(records, "DOMAIN_OWNERSHIP")[0].status).toBe("PENDING");
  });

  it("follows the Azure-AsyncOperation header to completion", async () => {
    const lro = `${ARM_BASE}/subscriptions/sub-1/providers/Microsoft.Communication/locations/global/operationStatuses/op-1`;
    const { provisioner, calls } = fakeArm([
      { match: `PUT ${ARM_BASE}`, status: 201, headers: { "Azure-AsyncOperation": lro }, reply: () => ({}) },
      { match: `GET ${lro}`, reply: () => ({ status: "Succeeded" }) },
      { match: `POST ${ARM_BASE}`, reply: () => ({}) },
      { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("NotStarted")) },
    ]);
    await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(armCalls(calls).some((c) => c.url === lro)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkDomain — state machine
// ---------------------------------------------------------------------------

describe("checkDomain state machine", () => {
  function checkWith(verificationStates: Record<string, unknown>, extra: Route[] = []) {
    return fakeArm([
      ...extra,
      { match: `POST ${ARM_BASE}`, reply: () => ({}) },
      { match: `GET ${ARM_BASE}/subscriptions/sub-1`, reply: () => domainResource(verificationStates) },
    ]);
  }

  function initiatedTypes(calls: Call[]) {
    return armCalls(calls)
      .filter((c) => c.method === "POST" && c.url.includes("initiateVerification"))
      .map((c) => c.body.verificationType);
  }

  it("starts Domain verification, and nothing else, while ownership is unproven", async () => {
    const { provisioner, calls } = checkWith(states("NotStarted"));
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(res.status).toBe("PENDING");
    expect(initiatedTypes(calls)).toEqual(["Domain"]);
  });

  it("does not start SPF/DKIM while Domain is only requested", async () => {
    const { provisioner, calls } = checkWith(states("VerificationRequested"));
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(res.status).toBe("PENDING");
    expect(initiatedTypes(calls)).toEqual([]);
  });

  it("starts SPF, DKIM and DKIM2 once Domain is Verified", async () => {
    const { provisioner, calls } = checkWith(states("Verified"));
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(res.status).toBe("PENDING");
    expect(initiatedTypes(calls)).toEqual(["SPF", "DKIM", "DKIM2"]);
    expect(byPurpose(res.records, "DOMAIN_OWNERSHIP")[0].status).toBe("VERIFIED");
    expect(byPurpose(res.records, "DKIM").every((r) => r.status === "NOT_STARTED")).toBe(true);
  });

  it("only re-initiates the types still NotStarted", async () => {
    const { provisioner, calls } = checkWith(states("Verified", "Verified", "VerificationInProgress", "NotStarted"));
    await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(initiatedTypes(calls)).toEqual(["DKIM2"]);
  });

  it("VerificationFailed fails the domain and surfaces the errorCode", async () => {
    const { provisioner } = checkWith({
      Domain: { status: "Verified" },
      SPF: { status: "VerificationFailed", errorCode: "DnsRecordNotFound" },
      DKIM: { status: "Verified" },
      DKIM2: { status: "Verified" },
    });
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(res.status).toBe("FAILED");
    expect(res.error).toBe("SPF verification failed (DnsRecordNotFound)");
    expect(byPurpose(res.records, "MAIL_FROM_SPF")[0].status).toBe("FAILED");
  });

  it("maps a 404 domain to FAILED", async () => {
    const { provisioner } = fakeArm([
      { match: `GET ${ARM_BASE}`, status: 404, reply: () => ({ error: { code: "ResourceNotFound", message: "gone" } }) },
    ]);
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(res).toEqual({ status: "FAILED", records: [], error: "domain not found at provider" });
  });

  it("maps ARM 5xx and throttling to TEMPORARY_FAILURE, not FAILED", async () => {
    for (const status of [500, 503, 429]) {
      const { provisioner } = fakeArm([
        { match: `GET ${ARM_BASE}`, status, reply: () => ({ error: { code: "ServiceUnavailable", message: "try later" } }) },
      ]);
      const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
      expect(res.status).toBe("TEMPORARY_FAILURE");
      expect(res.records).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// checkDomain — verification completion
// ---------------------------------------------------------------------------

describe("checkDomain when all four verify", () => {
  const allVerified = states("Verified", "Verified", "Verified", "Verified");

  function verifiedArm(linked: string[]) {
    const state = { linked: [...linked] };
    const { provisioner, calls } = fakeArm([
      { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
      { match: `PATCH ${ARM_BASE}`, reply: (c) => {
          state.linked = c.body.properties.linkedDomains;
          return {};
        } },
      { match: `GET ${ARM_BASE}/subscriptions/sub-1/resourceGroups/rg-amlify-email/providers/Microsoft.Communication/${ACS_PATH}`, reply: () => ({ properties: { linkedDomains: state.linked } }) },
      { match: `GET ${ARM_BASE}`, reply: () => domainResource(allVerified) },
    ]);
    return { provisioner, calls, state };
  }

  it("reports VERIFIED and registers the sender usernames", async () => {
    const { provisioner, calls } = verifiedArm(EXISTING_LINKED);
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });

    expect(res.status).toBe("VERIFIED");
    expect(res.error).toBeUndefined();
    expect(res.records.every((r) => r.status === "VERIFIED")).toBe(true);

    const senders = armCalls(calls)
      .filter((c) => c.method === "PUT" && c.url.includes("/senderUsernames/"))
      .map((c) => c.body.properties.username);
    expect(senders).toEqual(["noreply", "donotreply"]);
  });

  it("APPENDS to linkedDomains — the live senders already there survive", async () => {
    const { provisioner, calls, state } = verifiedArm(EXISTING_LINKED);
    await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });

    const patch = armCalls(calls).find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain(ACS_PATH);
    expect(patch.body.properties.linkedDomains).toEqual([...EXISTING_LINKED, DOMAIN_ID]);
    expect(state.linked).toEqual([...EXISTING_LINKED, DOMAIN_ID]);
  });

  it("does not PATCH at all when the domain is already linked", async () => {
    const { provisioner, calls } = verifiedArm([...EXISTING_LINKED, DOMAIN_ID]);
    await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(armCalls(calls).some((c) => c.method === "PATCH")).toBe(false);
  });

  it("treats a transient ARM failure during linking as TEMPORARY_FAILURE", async () => {
    const { provisioner } = fakeArm([
      { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
      { match: `GET ${ARM_BASE}/subscriptions/sub-1/resourceGroups/rg-amlify-email/providers/Microsoft.Communication/${ACS_PATH}`, status: 503, reply: () => ({ error: { code: "ServiceUnavailable", message: "nope" } }) },
      { match: `GET ${ARM_BASE}`, reply: () => domainResource(allVerified) },
    ]);
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(res.status).toBe("TEMPORARY_FAILURE");
    expect(res.records).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// deleteDomain
// ---------------------------------------------------------------------------

describe("deleteDomain", () => {
  function deleteArm(linked: string[], domainDeleteStatus = 200) {
    const state = { linked: [...linked] };
    const { provisioner, calls } = fakeArm([
      { match: `PATCH ${ARM_BASE}`, reply: (c) => {
          state.linked = c.body.properties.linkedDomains;
          return {};
        } },
      { match: `GET ${ARM_BASE}`, reply: () => ({ properties: { linkedDomains: state.linked } }) },
      {
        match: `DELETE ${ARM_BASE}`,
        status: domainDeleteStatus,
        reply: () => (domainDeleteStatus === 200 ? {} : { error: { code: "ResourceNotFound", message: "gone" } }),
      },
    ]);
    return { provisioner, calls, state };
  }

  it("removes ONLY its own entry from linkedDomains, then deletes", async () => {
    const { provisioner, calls, state } = deleteArm([EXISTING_LINKED[0], DOMAIN_ID, EXISTING_LINKED[1]]);
    await provisioner.deleteDomain(DOMAIN);

    const patch = armCalls(calls).find((c) => c.method === "PATCH")!;
    expect(patch.body.properties.linkedDomains).toEqual(EXISTING_LINKED);
    expect(state.linked).toEqual(EXISTING_LINKED);

    const del = armCalls(calls).find((c) => c.method === "DELETE")!;
    expect(del.url).toContain(DOMAIN_PATH);
    // Unlink must happen before the delete or ARM refuses it.
    expect(armCalls(calls).indexOf(patch)).toBeLessThan(armCalls(calls).indexOf(del));
  });

  it("does not touch linkedDomains when the domain was never linked", async () => {
    const { provisioner, calls } = deleteArm(EXISTING_LINKED);
    await provisioner.deleteDomain(DOMAIN);
    expect(armCalls(calls).some((c) => c.method === "PATCH")).toBe(false);
    expect(armCalls(calls).some((c) => c.method === "DELETE")).toBe(true);
  });

  it("swallows a 404 — an already-gone domain is a success", async () => {
    const { provisioner } = deleteArm(EXISTING_LINKED, 404);
    await expect(provisioner.deleteDomain(DOMAIN)).resolves.toBeUndefined();
  });

  it("still throws on any other provider error", async () => {
    const { provisioner } = fakeArm([
      { match: `GET ${ARM_BASE}`, reply: () => ({ properties: { linkedDomains: [] } }) },
      { match: `DELETE ${ARM_BASE}`, status: 403, reply: () => ({ error: { code: "AuthorizationFailed", message: "denied" } }) },
    ]);
    await expect(provisioner.deleteDomain(DOMAIN)).rejects.toThrow(/403 AuthorizationFailed/);
  });
});

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

describe("ARM token", () => {
  it("is fetched once and reused across calls, and never appears in a request URL", async () => {
    const { provisioner, calls } = fakeArm([
      { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
      { match: `POST ${ARM_BASE}`, reply: () => ({}) },
      { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("NotStarted")) },
    ]);
    await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });
    await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });

    const tokenCalls = calls.filter((c) => c.url.includes("login.microsoftonline.com"));
    expect(tokenCalls).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes(ARM.clientSecret))).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// SPF merge
// ---------------------------------------------------------------------------

/** ACS's stock value, and the include it is built around. */
const STOCK_SPF = "v=spf1 include:spf.protection.outlook.com -all";
const INCLUDE = "include:spf.protection.outlook.com";

/** Two live production domains about to be migrated onto ACS. Verified records. */
const TINTINPOS = "v=spf1 +mx +a +ip4:51.161.174.248 +include:relay.mailchannels.net ~all";
const MARO =
  "v=spf1 a mx ip4:51.161.174.248 ip4:68.168.220.58 include:_spf.google.com include:spf.antispamcloud.com include:relay.mailchannels.net ~all";

/** The SPF record as the provisioner actually hands it back. */
async function spfRecord(resolveTxt: (h: string) => Promise<string[][]>) {
  const { provisioner } = fakeArm(
    [
      { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
      { match: `POST ${ARM_BASE}`, reply: () => ({}) },
      { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("NotStarted")) },
    ],
    resolveTxt,
  );
  const { records } = await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });
  return byPurpose(records, "MAIL_FROM_SPF")[0];
}

describe("mergeSpf", () => {
  it("preserves the existing all qualifier — a soft fail is never upgraded to a hard fail", () => {
    expect(mergeSpf("v=spf1 a ~all")).toBe(`v=spf1 a ${INCLUDE} ~all`);
    expect(mergeSpf("v=spf1 a -all")).toBe(`v=spf1 a ${INCLUDE} -all`);
    expect(mergeSpf("v=spf1 a ?all")).toBe(`v=spf1 a ${INCLUDE} ?all`);
    expect(mergeSpf("v=spf1 a +all")).toBe(`v=spf1 a ${INCLUDE} +all`);
    // A bare `all` is an implicit `+all` and must stay bare.
    expect(mergeSpf("v=spf1 a all")).toBe(`v=spf1 a ${INCLUDE} all`);
  });

  it("inserts immediately before the all mechanism, keeping every other term in order", () => {
    expect(mergeSpf("v=spf1 mx a ip4:1.2.3.4 include:other.example -all")).toBe(
      `v=spf1 mx a ip4:1.2.3.4 include:other.example ${INCLUDE} -all`,
    );
  });

  it("appends when the record has no all mechanism at all", () => {
    expect(mergeSpf("v=spf1 a mx")).toBe(`v=spf1 a mx ${INCLUDE}`);
    expect(mergeSpf("v=spf1")).toBe(`v=spf1 ${INCLUDE}`);
  });

  it("appends rather than corrupting a redirect= record", () => {
    expect(mergeSpf("v=spf1 redirect=_spf.example.com")).toBe(
      `v=spf1 redirect=_spf.example.com ${INCLUDE}`,
    );
  });

  it("returns a record that already contains the include untouched", () => {
    expect(mergeSpf(STOCK_SPF)).toBe(STOCK_SPF);
    // An explicit `+` qualifier is the same mechanism, and shouting is legal.
    expect(mergeSpf("v=spf1 a +include:spf.protection.outlook.com ~all")).toBe(
      "v=spf1 a +include:spf.protection.outlook.com ~all",
    );
    expect(mergeSpf("v=spf1 INCLUDE:SPF.PROTECTION.OUTLOOK.COM -all")).toBe(
      "v=spf1 INCLUDE:SPF.PROTECTION.OUTLOOK.COM -all",
    );
  });

  it("merges the real tintinpos.com record", () => {
    expect(mergeSpf(TINTINPOS)).toBe(
      `v=spf1 +mx +a +ip4:51.161.174.248 +include:relay.mailchannels.net ${INCLUDE} ~all`,
    );
  });

  it("merges the real maro.com.au record", () => {
    expect(mergeSpf(MARO)).toBe(
      `v=spf1 a mx ip4:51.161.174.248 ip4:68.168.220.58 include:_spf.google.com include:spf.antispamcloud.com include:relay.mailchannels.net ${INCLUDE} ~all`,
    );
  });
});

describe("SPF record value", () => {
  it("is ACS's stock record, with no note, when the domain publishes no SPF", async () => {
    const record = await spfRecord(async () => [["some-other=verification-token"]]);
    expect(record.value).toBe(STOCK_SPF);
    expect(record.note).toBeUndefined();
  });

  it("merges the one v=spf1 record among many TXT records, and says so", async () => {
    const record = await spfRecord(async () => [
      ["google-site-verification=xyz"],
      ["v=spf1 a ~all"],
      ["v=DMARC1; p=none;"],
    ]);
    expect(record.value).toBe(`v=spf1 a ${INCLUDE} ~all`);
    expect(record.note).toMatch(/replace that record/i);
  });

  it("joins a 255-char-split record with no separator before merging", async () => {
    // Long records arrive chunked; a naive space-join would corrupt a mechanism
    // split mid-token.
    const head = "v=spf1 ip4:51.161.174.248 include:_spf.google.com inclu";
    const tail = "de:spf.antispamcloud.com ~all";
    const record = await spfRecord(async () => [[head, tail]]);
    expect(record.value).toBe(
      `v=spf1 ip4:51.161.174.248 include:_spf.google.com include:spf.antispamcloud.com ${INCLUDE} ~all`,
    );
  });

  it("returns an already-satisfied record verbatim and does not ask for a change", async () => {
    const existing = "v=spf1 a include:spf.protection.outlook.com ~all";
    const record = await spfRecord(async () => [[existing]]);
    expect(record.value).toBe(existing);
    expect(record.note).toMatch(/already authorises/i);
  });

  it("falls back to the stock record when the domain has two v=spf1 records", async () => {
    const record = await spfRecord(async () => [["v=spf1 a ~all"], ["v=spf1 mx -all"]]);
    expect(record.value).toBe(STOCK_SPF);
    expect(record.note).toMatch(/more than one SPF record/i);
  });

  it("falls back to the stock record when the resolver rejects, and warns", async () => {
    const record = await spfRecord(async () => {
      throw Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" });
    });
    expect(record.value).toBe(STOCK_SPF);
    expect(record.note).toMatch(/DNS lookup failed/i);
  });

  it("merges on checkDomain too, not just createDomain", async () => {
    const { provisioner } = fakeArm(
      [
        { match: `POST ${ARM_BASE}`, reply: () => ({}) },
        { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("Verified", "VerificationInProgress")) },
        { match: `PATCH ${ARM_BASE}`, reply: () => ({}) },
        { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
      ],
      async () => [[TINTINPOS]],
    );
    const res = await provisioner.checkDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(byPurpose(res.records, "MAIL_FROM_SPF")[0].value).toBe(
      `v=spf1 +mx +a +ip4:51.161.174.248 +include:relay.mailchannels.net ${INCLUDE} ~all`,
    );
  });

  it("leaves the other three records alone", async () => {
    const { provisioner } = fakeArm(
      [
        { match: `PUT ${ARM_BASE}`, reply: () => ({}) },
        { match: `POST ${ARM_BASE}`, reply: () => ({}) },
        { match: `GET ${ARM_BASE}`, reply: () => domainResource(states("NotStarted")) },
      ],
      async () => [[MARO]],
    );
    const { records } = await provisioner.createDomain(DOMAIN, { mailFromDomain: DOMAIN });
    expect(records.filter((r) => r.purpose !== "MAIL_FROM_SPF").every((r) => r.note === undefined)).toBe(true);
    expect(byPurpose(records, "DOMAIN_OWNERSHIP")[0].value).toBe("ms-domain-verification=abc123");
  });
});
