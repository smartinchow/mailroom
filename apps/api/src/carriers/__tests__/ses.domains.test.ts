import { describe, expect, it, vi } from "vitest";
import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  PutEmailIdentityMailFromAttributesCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2";
import { createSesCarrier } from "../ses.js";
import type { DnsRecord, SesConfig } from "../types.js";

/**
 * Domain provisioning against an injected fake SESv2 client — no AWS call is
 * ever made, and no mocking library is needed. The DMARC lookup is injected
 * too, since SES never reports it.
 */

const CONFIG: SesConfig = {
  type: "ses",
  region: "ap-southeast-2",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  configurationSet: "mailroom",
};

const TOKENS = ["tok1aaa", "tok2bbb", "tok3ccc"];

type Handler = (command: unknown) => unknown;

/** Minimal stand-in for SESv2Client: records commands, replies from handlers. */
function fakeClient(handlers: { match: (c: unknown) => boolean; reply: Handler }[]) {
  const sent: unknown[] = [];
  const client = {
    async send(command: unknown) {
      sent.push(command);
      for (const h of handlers) {
        if (h.match(command)) {
          const out = h.reply(command);
          if (out instanceof Error) throw out;
          return out;
        }
      }
      throw new Error(`unexpected command ${(command as object).constructor.name}`);
    },
  };
  return { client: client as unknown as SESv2Client, sent };
}

const is = (Ctor: new (...args: never[]) => unknown) => (c: unknown) => c instanceof Ctor;

const noDmarc = vi.fn(async () => {
  throw new Error("ENOTFOUND");
});

function carrierWith(
  handlers: { match: (c: unknown) => boolean; reply: Handler }[],
  resolveTxt: (h: string) => Promise<string[][]> = noDmarc,
) {
  const { client, sent } = fakeClient(handlers);
  return { carrier: createSesCarrier(CONFIG, { client, resolveTxt }), sent };
}

function byPurpose(records: DnsRecord[], purpose: DnsRecord["purpose"]) {
  return records.filter((r) => r.purpose === purpose);
}

// ---------------------------------------------------------------------------
// createDomain
// ---------------------------------------------------------------------------

describe("createDomain", () => {
  it("builds the exact six records for example.com in ap-southeast-2", async () => {
    const { carrier, sent } = carrierWith([
      { match: is(CreateEmailIdentityCommand), reply: () => ({ DkimAttributes: { Tokens: TOKENS } }) },
      { match: is(PutEmailIdentityMailFromAttributesCommand), reply: () => ({}) },
    ]);

    const { records } = await carrier.domains!.createDomain("example.com", {
      mailFromDomain: "send.example.com",
    });

    expect(records).toHaveLength(6);
    expect(records).toEqual([
      {
        type: "CNAME",
        name: "tok1aaa._domainkey.example.com",
        value: "tok1aaa.dkim.amazonses.com",
        ttl: 300,
        purpose: "DKIM",
        required: true,
        status: "PENDING",
      },
      {
        type: "CNAME",
        name: "tok2bbb._domainkey.example.com",
        value: "tok2bbb.dkim.amazonses.com",
        ttl: 300,
        purpose: "DKIM",
        required: true,
        status: "PENDING",
      },
      {
        type: "CNAME",
        name: "tok3ccc._domainkey.example.com",
        value: "tok3ccc.dkim.amazonses.com",
        ttl: 300,
        purpose: "DKIM",
        required: true,
        status: "PENDING",
      },
      {
        type: "MX",
        name: "send.example.com",
        value: "feedback-smtp.ap-southeast-2.amazonses.com",
        priority: 10,
        ttl: 300,
        purpose: "MAIL_FROM_MX",
        required: true,
        status: "PENDING",
      },
      {
        type: "TXT",
        name: "send.example.com",
        value: "v=spf1 include:amazonses.com ~all",
        ttl: 300,
        purpose: "MAIL_FROM_SPF",
        required: true,
        status: "PENDING",
      },
      {
        type: "TXT",
        name: "_dmarc.example.com",
        value: "v=DMARC1; p=none;",
        ttl: 300,
        purpose: "DMARC",
        required: false,
        status: "PENDING",
      },
    ]);

    const create = sent[0] as CreateEmailIdentityCommand;
    expect(create.input).toEqual({
      EmailIdentity: "example.com",
      ConfigurationSetName: "mailroom",
      DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
    });
    const mailFrom = sent[1] as PutEmailIdentityMailFromAttributesCommand;
    expect(mailFrom.input).toEqual({
      EmailIdentity: "example.com",
      MailFromDomain: "send.example.com",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
  });

  it("falls through to GetEmailIdentity when the identity already exists", async () => {
    const { carrier, sent } = carrierWith([
      {
        match: is(CreateEmailIdentityCommand),
        reply: () => new AlreadyExistsException({ $metadata: {}, message: "already exists" }),
      },
      { match: is(GetEmailIdentityCommand), reply: () => ({ DkimAttributes: { Tokens: TOKENS } }) },
      { match: is(PutEmailIdentityMailFromAttributesCommand), reply: () => ({}) },
    ]);

    const { records } = await carrier.domains!.createDomain("example.com", {
      mailFromDomain: "send.example.com",
    });

    expect(sent[1]).toBeInstanceOf(GetEmailIdentityCommand);
    expect(byPurpose(records, "DKIM").map((r) => r.name)).toEqual([
      "tok1aaa._domainkey.example.com",
      "tok2bbb._domainkey.example.com",
      "tok3ccc._domainkey.example.com",
    ]);
  });

  it("propagates any error that is not AlreadyExists", async () => {
    const { carrier } = carrierWith([
      { match: is(CreateEmailIdentityCommand), reply: () => new Error("AccessDenied") },
    ]);
    await expect(
      carrier.domains!.createDomain("example.com", { mailFromDomain: "send.example.com" }),
    ).rejects.toThrow("AccessDenied");
  });
});

// ---------------------------------------------------------------------------
// checkDomain
// ---------------------------------------------------------------------------

function getIdentity(dkim: string, mailFrom: string) {
  return [
    {
      match: is(GetEmailIdentityCommand),
      reply: () => ({
        DkimAttributes: { Status: dkim, Tokens: TOKENS },
        MailFromAttributes: { MailFromDomain: "send.example.com", MailFromDomainStatus: mailFrom },
      }),
    },
  ];
}

describe("checkDomain status matrix", () => {
  it("SUCCESS + SUCCESS verifies the domain and every required record", async () => {
    const { carrier } = carrierWith(getIdentity("SUCCESS", "SUCCESS"));
    const res = await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res.status).toBe("VERIFIED");
    expect(res.error).toBeUndefined();
    for (const r of res.records.filter((x) => x.required)) expect(r.status).toBe("VERIFIED");
  });

  it("FAILED DKIM fails the domain and marks the DKIM records FAILED", async () => {
    const { carrier } = carrierWith(getIdentity("FAILED", "SUCCESS"));
    const res = await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res.status).toBe("FAILED");
    expect(res.error).toContain("DKIM");
    expect(byPurpose(res.records, "DKIM").every((r) => r.status === "FAILED")).toBe(true);
    expect(byPurpose(res.records, "MAIL_FROM_MX")[0].status).toBe("VERIFIED");
  });

  it("FAILED MAIL FROM fails the domain", async () => {
    const { carrier } = carrierWith(getIdentity("SUCCESS", "FAILED"));
    const res = await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res.status).toBe("FAILED");
    expect(res.error).toContain("MAIL FROM");
  });

  it("TEMPORARY_FAILURE keeps the domain retryable and the record PENDING", async () => {
    const { carrier } = carrierWith(getIdentity("TEMPORARY_FAILURE", "PENDING"));
    const res = await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res.status).toBe("TEMPORARY_FAILURE");
    expect(byPurpose(res.records, "DKIM").every((r) => r.status === "PENDING")).toBe(true);
  });

  it("PENDING / NOT_STARTED stay PENDING", async () => {
    const { carrier } = carrierWith(getIdentity("PENDING", "PENDING"));
    expect(
      (await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" })).status,
    ).toBe("PENDING");

    const { carrier: c2 } = carrierWith(getIdentity("NOT_STARTED", "PENDING"));
    const res2 = await c2.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res2.status).toBe("PENDING");
    expect(byPurpose(res2.records, "DKIM").every((r) => r.status === "PENDING")).toBe(true);
  });

  it("FAILED beats TEMPORARY_FAILURE", async () => {
    const { carrier } = carrierWith(getIdentity("FAILED", "TEMPORARY_FAILURE"));
    const res = await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res.status).toBe("FAILED");
  });

  it("verifies DMARC from the TXT lookup, and never throws when DNS fails", async () => {
    const found = carrierWith(getIdentity("PENDING", "PENDING"), async () => [["v=DMARC1; p=quarantine;"]]);
    const withDmarc = await found.carrier.domains!.checkDomain("example.com", {
      mailFromDomain: "send.example.com",
    });
    expect(byPurpose(withDmarc.records, "DMARC")[0].status).toBe("VERIFIED");

    const broken = carrierWith(getIdentity("PENDING", "PENDING"), async () => {
      throw new Error("ESERVFAIL");
    });
    const noDmarcRes = await broken.carrier.domains!.checkDomain("example.com", {
      mailFromDomain: "send.example.com",
    });
    expect(byPurpose(noDmarcRes.records, "DMARC")[0].status).toBe("PENDING");
    expect(noDmarcRes.status).toBe("PENDING");
  });

  it("maps NotFoundException to FAILED with an explanatory error", async () => {
    const { carrier } = carrierWith([
      {
        match: is(GetEmailIdentityCommand),
        reply: () => new NotFoundException({ $metadata: {}, message: "nope" }),
      },
    ]);
    const res = await carrier.domains!.checkDomain("example.com", { mailFromDomain: "send.example.com" });
    expect(res).toEqual({ status: "FAILED", records: [], error: "identity not found at provider" });
  });
});

// ---------------------------------------------------------------------------
// deleteDomain
// ---------------------------------------------------------------------------

describe("deleteDomain", () => {
  it("issues DeleteEmailIdentity", async () => {
    const { carrier, sent } = carrierWith([{ match: is(DeleteEmailIdentityCommand), reply: () => ({}) }]);
    await carrier.domains!.deleteDomain("example.com");
    expect((sent[0] as DeleteEmailIdentityCommand).input).toEqual({ EmailIdentity: "example.com" });
  });

  it("swallows NotFoundException — an already-gone identity is a success", async () => {
    const { carrier } = carrierWith([
      {
        match: is(DeleteEmailIdentityCommand),
        reply: () => new NotFoundException({ $metadata: {}, message: "gone" }),
      },
    ]);
    await expect(carrier.domains!.deleteDomain("example.com")).resolves.toBeUndefined();
  });

  it("still throws on any other provider error", async () => {
    const { carrier } = carrierWith([
      { match: is(DeleteEmailIdentityCommand), reply: () => new Error("Throttling") },
    ]);
    await expect(carrier.domains!.deleteDomain("example.com")).rejects.toThrow("Throttling");
  });
});
