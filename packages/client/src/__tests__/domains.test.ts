import { afterEach, describe, expect, it, vi } from "vitest";
import { createMailroom } from "../index.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const emptyResponse = (status: number): Response => new Response(null, { status });

const mailroom = () => createMailroom({ url: "https://mailroom.example.test", apiKey: "mr_live_test123" });

const wireDomain = {
  id: "dom_01JTEST",
  name: "example.com",
  status: "pending",
  carrier: { id: "car_01", name: "ses-mailroom", type: "SES" },
  project_id: "proj_01",
  mail_from_domain: "send.example.com",
  records: [
    {
      type: "CNAME",
      name: "abc._domainkey.example.com",
      value: "abc.dkim.amazonses.com",
      priority: null,
      ttl: 300,
      purpose: "dkim",
      required: true,
      status: "pending",
    },
  ],
  sender_usernames: [{ username: "support", displayName: "Support" }],
  verified_at: null,
  last_checked_at: null,
  verification_error: null,
  created_at: "2026-09-04T00:00:00.000Z",
};

const camelDomain = {
  id: "dom_01JTEST",
  name: "example.com",
  status: "pending",
  carrier: { id: "car_01", name: "ses-mailroom", type: "SES" },
  projectId: "proj_01",
  mailFromDomain: "send.example.com",
  records: [
    {
      type: "CNAME",
      name: "abc._domainkey.example.com",
      value: "abc.dkim.amazonses.com",
      priority: null,
      ttl: 300,
      purpose: "dkim",
      required: true,
      status: "pending",
    },
  ],
  senderUsernames: [{ username: "support", displayName: "Support" }],
  verifiedAt: null,
  lastCheckedAt: null,
  verificationError: null,
  createdAt: "2026-09-04T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("domains.create", () => {
  it("POSTs { name } to /v1/domains and returns the camelCase Domain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, wireDomain));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailroom().domains.create({ name: "example.com" });

    expect(result).toEqual(camelDomain);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://mailroom.example.test/v1/domains");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer mr_live_test123");
    expect(JSON.parse(init.body as string)).toEqual({ name: "example.com" });
  });
});

describe("domains.list", () => {
  it("GETs /v1/domains and returns { data: Domain[] } in camelCase", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [wireDomain] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailroom().domains.list();

    expect(result).toEqual({ data: [camelDomain] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mailroom.example.test/v1/domains");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});

describe("domains.get", () => {
  it("GETs /v1/domains/:id and returns the camelCase Domain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, wireDomain));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailroom().domains.get("dom_01JTEST");

    expect(result).toEqual(camelDomain);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mailroom.example.test/v1/domains/dom_01JTEST");
    expect(init.method).toBe("GET");
  });
});

describe("domains.verify", () => {
  it("POSTs /v1/domains/:id/verify with no body and returns the updated Domain", async () => {
    const verified = { ...wireDomain, status: "verified", verified_at: "2026-09-04T01:00:00.000Z" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, verified));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailroom().domains.verify("dom_01JTEST");

    expect(result).toEqual({ ...camelDomain, status: "verified", verifiedAt: "2026-09-04T01:00:00.000Z" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mailroom.example.test/v1/domains/dom_01JTEST/verify");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("domains.remove", () => {
  it("DELETEs /v1/domains/:id and resolves to void on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailroom().domains.remove("dom_01JTEST");

    expect(result).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mailroom.example.test/v1/domains/dom_01JTEST");
    expect(init.method).toBe("DELETE");
  });
});
