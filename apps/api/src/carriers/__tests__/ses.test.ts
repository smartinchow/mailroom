import { afterEach, describe, expect, it, vi } from "vitest";
import { createSign } from "node:crypto";
import { createSesCarrier } from "../ses.js";
import type { RawRequest, SesConfig } from "../types.js";

/**
 * SES carrier tests. Duplicate + out-of-order event arrival is handled by the
 * ingest layer, not here — these tests cover the mapping, suppress flags,
 * recipient extraction and timestamps, plus SNS hook verification.
 */

const CONFIG: SesConfig = {
  type: "ses",
  region: "ap-southeast-2",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  configurationSet: "mailroom-events",
};

const carrier = createSesCarrier(CONFIG);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MSG_ID = "0100019876543210-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000";

const MAIL = {
  timestamp: "2026-08-27T01:00:00.000Z",
  source: "no-reply@vine-it.org",
  messageId: MSG_ID,
  destination: ["jane@example.com"],
};

/** Wrap an SES event the way SNS delivers it: JSON string in `Message`. */
function snsWrap(sesEvent: unknown): Record<string, unknown> {
  return {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: "arn:aws:sns:ap-southeast-2:123456789012:mailroom-events",
    Message: JSON.stringify(sesEvent),
    Timestamp: "2026-08-27T01:00:05.000Z",
    SignatureVersion: "1",
    Signature: "not-checked-by-parseEvents",
    SigningCertURL:
      "https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-abc123.pem",
    UnsubscribeURL:
      "https://sns.ap-southeast-2.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn",
  };
}

// ---------------------------------------------------------------------------
// parseEvents
// ---------------------------------------------------------------------------

describe("parseEvents", () => {
  it("maps Delivery to DELIVERED with recipient and delivery timestamp", () => {
    const ses = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: {
        timestamp: "2026-08-27T01:00:03.000Z",
        recipients: ["jane@example.com"],
        smtpResponse: "250 2.6.0 Message received",
      },
    };
    const events = carrier.parseEvents(snsWrap(ses));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: MSG_ID,
      type: "DELIVERED",
      recipient: "jane@example.com",
      detail: "250 2.6.0 Message received",
    });
    expect(events[0]!.occurredAt).toEqual(new Date("2026-08-27T01:00:03.000Z"));
    expect(events[0]!.suppress).toBeUndefined();
    expect(events[0]!.providerRaw).toEqual(ses); // the parsed SES event, not the SNS envelope
  });

  it("maps a Permanent Bounce to BOUNCED with HARD_BOUNCE suppression and diagnosticCode", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Bounce",
        mail: MAIL,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          timestamp: "2026-08-27T01:00:04.000Z",
          bouncedRecipients: [
            {
              emailAddress: "jane@example.com",
              diagnosticCode: "smtp; 550 5.1.1 user unknown",
            },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: MSG_ID,
      type: "BOUNCED",
      recipient: "jane@example.com",
      suppress: { reason: "HARD_BOUNCE" },
      detail: "smtp; 550 5.1.1 user unknown",
    });
    expect(events[0]!.occurredAt).toEqual(new Date("2026-08-27T01:00:04.000Z"));
  });

  it("emits one BOUNCED event per bounced recipient", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Bounce",
        mail: { ...MAIL, destination: ["a@example.com", "b@example.com"] },
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          timestamp: "2026-08-27T01:00:04.000Z",
          bouncedRecipients: [
            { emailAddress: "a@example.com", diagnosticCode: "550 no a" },
            { emailAddress: "b@example.com", diagnosticCode: "550 no b" },
          ],
        },
      }),
    );
    expect(events.map((e) => [e.recipient, e.detail])).toEqual([
      ["a@example.com", "550 no a"],
      ["b@example.com", "550 no b"],
    ]);
    expect(events.every((e) => e.type === "BOUNCED")).toBe(true);
    expect(events.every((e) => e.suppress?.reason === "HARD_BOUNCE")).toBe(true);
  });

  it("maps a Transient Bounce to DELAYED with no suppression", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Bounce",
        mail: MAIL,
        bounce: {
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
          timestamp: "2026-08-27T01:00:04.000Z",
          bouncedRecipients: [{ emailAddress: "jane@example.com" }],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "DELAYED",
      recipient: "jane@example.com",
      detail: "Transient/MailboxFull", // falls back to type/subtype without a diagnosticCode
    });
    expect(events[0]!.suppress).toBeUndefined();
  });

  it("maps Complaint to COMPLAINED with COMPLAINT suppression", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Complaint",
        mail: MAIL,
        complaint: {
          timestamp: "2026-08-27T02:00:00.000Z",
          complainedRecipients: [{ emailAddress: "jane@example.com" }],
          complaintFeedbackType: "abuse",
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: MSG_ID,
      type: "COMPLAINED",
      recipient: "jane@example.com",
      suppress: { reason: "COMPLAINT" },
      detail: "abuse",
    });
    expect(events[0]!.occurredAt).toEqual(new Date("2026-08-27T02:00:00.000Z"));
  });

  it("maps Reject to FAILED with the reject reason, timestamped from mail", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Reject",
        mail: MAIL,
        reject: { reason: "Bad content" },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "FAILED",
      recipient: "jane@example.com",
      detail: "Bad content",
    });
    // Reject has no timestamp of its own — falls back to mail.timestamp.
    expect(events[0]!.occurredAt).toEqual(new Date(MAIL.timestamp));
  });

  it("maps Open to OPENED using the open timestamp", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Open",
        mail: MAIL,
        open: {
          timestamp: "2026-08-27T03:00:00.000Z",
          ipAddress: "203.0.113.10",
          userAgent: "Mozilla/5.0",
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "OPENED", recipient: "jane@example.com" });
    expect(events[0]!.occurredAt).toEqual(new Date("2026-08-27T03:00:00.000Z"));
  });

  it("maps Click to CLICKED with the clicked link as detail", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Click",
        mail: MAIL,
        click: {
          timestamp: "2026-08-27T03:01:00.000Z",
          link: "https://app.example.com/verify?token=t",
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "CLICKED",
      detail: "https://app.example.com/verify?token=t",
    });
    expect(events[0]!.occurredAt).toEqual(new Date("2026-08-27T03:01:00.000Z"));
  });

  it("leaves Open/Click recipient unset when the mail had multiple destinations", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "Open",
        mail: { ...MAIL, destination: ["a@example.com", "b@example.com"] },
        open: { timestamp: "2026-08-27T03:00:00.000Z" },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.recipient).toBeUndefined();
  });

  it("maps DeliveryDelay to DELAYED with delayed recipient and diagnostic", () => {
    const events = carrier.parseEvents(
      snsWrap({
        eventType: "DeliveryDelay",
        mail: MAIL,
        deliveryDelay: {
          timestamp: "2026-08-27T04:00:00.000Z",
          delayType: "MailboxFull",
          delayedRecipients: [
            { emailAddress: "jane@example.com", diagnosticCode: "452 4.2.2 mailbox full" },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "DELAYED",
      recipient: "jane@example.com",
      detail: "452 4.2.2 mailbox full",
    });
    expect(events[0]!.suppress).toBeUndefined();
    expect(events[0]!.occurredAt).toEqual(new Date("2026-08-27T04:00:00.000Z"));
  });

  it("ignores Send and unknown event types (log only)", () => {
    expect(
      carrier.parseEvents(snsWrap({ eventType: "Send", mail: MAIL, send: {} })),
    ).toEqual([]);
    expect(
      carrier.parseEvents(snsWrap({ eventType: "Subscription", mail: MAIL })),
    ).toEqual([]);
  });

  it("accepts legacy notificationType payloads too", () => {
    const events = carrier.parseEvents(
      snsWrap({
        notificationType: "Bounce",
        mail: MAIL,
        bounce: {
          bounceType: "Permanent",
          timestamp: "2026-08-27T01:00:04.000Z",
          bouncedRecipients: [{ emailAddress: "jane@example.com" }],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("BOUNCED");
  });

  it("returns nothing for a non-JSON Message or a non-Notification envelope", () => {
    expect(
      carrier.parseEvents({ Type: "Notification", Message: "not json at all" }),
    ).toEqual([]);
    expect(
      carrier.parseEvents({
        Type: "SubscriptionConfirmation",
        Message: JSON.stringify({ eventType: "Delivery", mail: MAIL, delivery: {} }),
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verifyHook — rejection paths that need no network
// ---------------------------------------------------------------------------

function rawReq(body: unknown): RawRequest {
  return { headers: {}, body };
}

function baseNotification(): Record<string, unknown> {
  return {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: "arn:aws:sns:ap-southeast-2:123456789012:mailroom-events",
    Message: "{}",
    Timestamp: "2026-08-27T01:00:05.000Z",
    SignatureVersion: "1",
    Signature: Buffer.from("sig").toString("base64"),
    SigningCertURL:
      "https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-abc.pem",
  };
}

describe("verifyHook rejections (offline)", () => {
  it("rejects a body that is not an SNS message", async () => {
    expect(await carrier.verifyHook(rawReq(null))).toMatchObject({ ok: false });
    expect(await carrier.verifyHook(rawReq([1, 2]))).toMatchObject({ ok: false });
    expect(
      await carrier.verifyHook({ headers: {}, body: undefined, rawBody: "notjson" }),
    ).toMatchObject({ ok: false });
  });

  it("rejects an http (non-https) SigningCertURL", async () => {
    const msg = baseNotification();
    msg.SigningCertURL = "http://sns.ap-southeast-2.amazonaws.com/cert.pem";
    const verdict = await carrier.verifyHook(rawReq(msg));
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("SigningCertURL") });
  });

  it("rejects a SigningCertURL on a foreign host", async () => {
    for (const host of [
      "https://evil.example.com/cert.pem",
      "https://sns.ap-southeast-2.amazonaws.com.evil.example/cert.pem",
      "https://xsns.ap-southeast-2.amazonaws.com/cert.pem",
      "https://s3.ap-southeast-2.amazonaws.com/cert.pem",
    ]) {
      const msg = baseNotification();
      msg.SigningCertURL = host;
      const verdict = await carrier.verifyHook(rawReq(msg));
      expect(verdict).toMatchObject({ ok: false });
    }
  });

  it("rejects a SigningCertURL that is not a .pem", async () => {
    const msg = baseNotification();
    msg.SigningCertURL = "https://sns.ap-southeast-2.amazonaws.com/anything";
    expect(await carrier.verifyHook(rawReq(msg))).toMatchObject({ ok: false });
  });

  it("rejects an unsupported SignatureVersion", async () => {
    const msg = baseNotification();
    msg.SignatureVersion = "3";
    const verdict = await carrier.verifyHook(rawReq(msg));
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("SignatureVersion") });
  });

  it("rejects when Signature or signed fields are missing", async () => {
    const noSig = baseNotification();
    delete noSig.Signature;
    expect(await carrier.verifyHook(rawReq(noSig))).toMatchObject({ ok: false });

    const noTimestamp = baseNotification();
    delete noTimestamp.Timestamp;
    expect(await carrier.verifyHook(rawReq(noTimestamp))).toMatchObject({ ok: false });

    const noTopic = baseNotification();
    delete noTopic.TopicArn;
    expect(await carrier.verifyHook(rawReq(noTopic))).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// verifyHook — happy path with a mocked certificate fetch
// ---------------------------------------------------------------------------

// Throwaway self-signed RSA cert + key generated for this test suite only.
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUEwnXxbXK5pOK4VVrxFqOQv/RRGgwDQYJKoZIhvcNAQEL
BQAwKzEpMCcGA1UEAwwgc25zLmFwLXNvdXRoZWFzdC0yLmFtYXpvbmF3cy5jb20w
HhcNMjYwODI3MTM0MTU2WhcNMzYwODI0MTM0MTU2WjArMSkwJwYDVQQDDCBzbnMu
YXAtc291dGhlYXN0LTIuYW1hem9uYXdzLmNvbTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMR8q2CfHuKxbsuaG1kuOpj5NvH1lLZXEHJD2YNv8JiLWHUU
CvIEHXtEnpiCdH7JfJMk53DPqIc346HUkrUiuo3uMYsy8KSyXGcpv06lTwLrN9nC
lBQR7MPQ9GBPKk/PkrXhISxyp+rDLQf+1v72qv/ZQ3HV37Zv93zat8ZoOzofMSug
a49FWS9A9XYGbGeBVv5dvf+aHePKMzSjgJlgQjPthdImhl3BjQSrExoy9hQFEIak
9KrCUXITISJVunwcl7rBnObVfNIE6o0akffEpptKdyv3/Q+Y7wNnu89NJYY8y/yh
d2nCrwRTOaJrcTibyVo2irbGcyY7L6rq+K1AJVkCAwEAAaNTMFEwHQYDVR0OBBYE
FM/Sp50pcIqoFWHB/qipEUS0xj5yMB8GA1UdIwQYMBaAFM/Sp50pcIqoFWHB/qip
EUS0xj5yMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAKsI8N5g
bhqnh/oXBsVc50YYqy9sh/IsHKlbCAOxuer8ZYnpHSMB2pacRyKDiblcMOLKpFex
KXkKGJE7BhaSDesQsuk6taz+brl2gW5F3bhqUIEWHWta58bSev+eGXZQJahdbbMd
H8w8vf64rBSP2FtW0wnXj/JTpsgkrRXUD6gb0U0GMuJ9cfNJjuai1xZKMTAWU7Ji
WYpqSUs6DEUYl7wj4J+92Ua58N/2EV4JetLopTXPu8uOxxuavXlniFTVqAz/IlPG
0CzieaX/IomDyriVYZUYIjcGtnZQ8ckWgRJE7KDFov0vVVTyQlLdn/b6aTAGWf1a
66EuW9rm/E8r2Ug=
-----END CERTIFICATE-----`;

const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDEfKtgnx7isW7L
mhtZLjqY+Tbx9ZS2VxByQ9mDb/CYi1h1FAryBB17RJ6YgnR+yXyTJOdwz6iHN+Oh
1JK1IrqN7jGLMvCkslxnKb9OpU8C6zfZwpQUEezD0PRgTypPz5K14SEscqfqwy0H
/tb+9qr/2UNx1d+2b/d82rfGaDs6HzEroGuPRVkvQPV2BmxngVb+Xb3/mh3jyjM0
o4CZYEIz7YXSJoZdwY0EqxMaMvYUBRCGpPSqwlFyEyEiVbp8HJe6wZzm1XzSBOqN
GpH3xKabSncr9/0PmO8DZ7vPTSWGPMv8oXdpwq8EUzmia3E4m8laNoq2xnMmOy+q
6vitQCVZAgMBAAECggEABWWue3Mp5Dlr436llt4hnYdMjnob2wpdmRXq1dgJHteT
cKioe4KVByH/M6dAHFkPT/Q1wbAiklxJp229/ej1tBjBfNZdLKXHMTPakNMS1Lyx
uXL4oeuzU9Z1VmccsKAkb1SL/O5e7tO5QYmRgRcB4xDZVmyOizKPwZRsc3z0RSHL
zojnsRarX2T2OU/QRJj2yjTYwLsRWvWsKRvYj5wxLd3sip1Uv4CHJNI+EH1qp3Eb
buCtyUDG1O90vQ3dJWAulDLsOzEz1w46d2BXo6j9w+6cQDs+63DLTBqJC6HHJm0d
eiZkVtbUgajOeM1A13uXJjFy+rhJFfnI1YvrMxziUQKBgQD789qrH9CGDJW3or7L
EpMwQoHAuFa+MS0UmSFepiVOygHsCYrEpI5d/Fgm0ATtx6FvJjW78VK6y/P6mQcr
k5yd2pTQMKch7F7cPH4Mm8wKeqgQPOH9O4nbcsOi0YMyeUDQYkyS2jPtyaIyTwE1
yIzQoi6w/ZhoR1H7DvgtNvyRBQKBgQDHpLcSfUjJ99/FHCtkEVIfzGDmukbcH9pO
3/53zm8V0b6pjIBuEqpYnvNu9WnLpzx0wSW4YOdJKK7h3QmlHX8LQYsiloVoxKWj
8Z3FJxgtEz3zLAWYfSeSvZLXS/EzcPI2d5EIkCF9ubG4khw2KCA7GmjIQ8sfdBqb
SsFX0LIDRQKBgQCOMar4pyTtco7Qq/XX8CzHsNE/7glun5xcoqu1mjk2BUYea6g4
oNKEcpVhmkcd12vhqgPrhR/2soKIrPLiAhYC9MjF0p+QwrEqxK0y+n6mb2EIgQPe
AkskYdnNu0a7JrmQodmri6CBFCoJEJOTQhNO8Ck/1G++cnnvIhyoj/7s7QKBgHpp
TLdRimgMTHCXrSNWW3yT3HackQY3oavrPCRJt2MxkC51r+nOGBTuoWTPpWbxy+fq
5i3/fNEm2NQ0q81KILPOJHm4wWRT7xxu8cYJCpHY0otf2q59Tt5yzq6kKejYwCsV
dSBC/8YPLiF1tUafo+OZddYVe1512jqNw68Mj5nhAoGBAPRw/6vh+Of8wum3jXG1
r4OXOxRDhdCr+sG+Pth18Z0L4T05lnScq97D2cVbK8XzK1hIKOs0qklJyfOay6O7
gFTElPmsTgrOqM/Ge5CPmrA/nxUXv6x/X1Z05vr90lSCX+lYVe/Wt9j7v5TddYAW
h9pY9LlcRjSf2aazGIuUD41X
-----END PRIVATE KEY-----`;

/** Sign an SNS envelope the way SNS does (same canonical string, our test key). */
function signEnvelope(env: Record<string, unknown>): string {
  const keys =
    env.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  let toSign = "";
  for (const key of keys) {
    if (env[key] == null) continue;
    toSign += `${key}\n${env[key]}\n`;
  }
  const signer = createSign(env.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(toSign, "utf8");
  return signer.sign(TEST_KEY_PEM, "base64");
}

function mockFetch(handler?: (url: string) => Partial<Response> | undefined) {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    const custom = handler?.(url);
    if (custom) return custom as Response;
    if (url.endsWith(".pem")) {
      return { ok: true, status: 200, text: async () => TEST_CERT_PEM } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => "" } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyHook with a verifiable signature (mocked cert fetch)", () => {
  // Distinct cert URLs per test: the carrier caches certificates per URL.
  function certUrl(tag: string): string {
    return `https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-${tag}.pem`;
  }

  it("accepts a correctly signed Notification (SignatureVersion 1, SHA1)", async () => {
    mockFetch();
    const msg = baseNotification();
    msg.SigningCertURL = certUrl("v1");
    msg.Signature = signEnvelope(msg);
    expect(await carrier.verifyHook(rawReq(msg))).toEqual({ ok: true });
  });

  it("accepts a correctly signed Notification (SignatureVersion 2, SHA256)", async () => {
    mockFetch();
    const msg = baseNotification();
    msg.SigningCertURL = certUrl("v2");
    msg.SignatureVersion = "2";
    msg.Signature = signEnvelope(msg);
    expect(await carrier.verifyHook(rawReq(msg))).toEqual({ ok: true });
  });

  it("rejects when the payload was tampered with after signing", async () => {
    mockFetch();
    const msg = baseNotification();
    msg.SigningCertURL = certUrl("tamper");
    msg.Signature = signEnvelope(msg);
    msg.Message = JSON.stringify({ eventType: "Delivery", forged: true });
    const verdict = await carrier.verifyHook(rawReq(msg));
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
  });

  it("confirms a signed SubscriptionConfirmation by fetching the SubscribeURL", async () => {
    const fetched: string[] = [];
    mockFetch((url) => {
      fetched.push(url);
      return undefined;
    });
    const msg: Record<string, unknown> = {
      Type: "SubscriptionConfirmation",
      MessageId: "m-2",
      Token: "tok-123",
      TopicArn: "arn:aws:sns:ap-southeast-2:123456789012:mailroom-events",
      Message: "You have chosen to subscribe...",
      SubscribeURL:
        "https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription&Token=tok-123",
      Timestamp: "2026-08-27T01:00:05.000Z",
      SignatureVersion: "1",
      SigningCertURL: certUrl("confirm"),
    };
    msg.Signature = signEnvelope(msg);
    const verdict = await carrier.verifyHook(rawReq(msg));
    expect(verdict).toEqual({ ok: true, respondWith: { ok: true } });
    expect(fetched).toContain(String(msg.SubscribeURL));
  });

  it("rejects a SubscriptionConfirmation whose SubscribeURL points off AWS, even when signed", async () => {
    const fetched: string[] = [];
    mockFetch((url) => {
      fetched.push(url);
      return undefined;
    });
    const msg: Record<string, unknown> = {
      Type: "SubscriptionConfirmation",
      MessageId: "m-3",
      Token: "tok-456",
      TopicArn: "arn:aws:sns:ap-southeast-2:123456789012:mailroom-events",
      Message: "You have chosen to subscribe...",
      SubscribeURL: "https://evil.example.com/?Action=ConfirmSubscription",
      Timestamp: "2026-08-27T01:00:05.000Z",
      SignatureVersion: "1",
      SigningCertURL: certUrl("confirm-evil"),
    };
    msg.Signature = signEnvelope(msg);
    const verdict = await carrier.verifyHook(rawReq(msg));
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("SubscribeURL") });
    expect(fetched).not.toContain("https://evil.example.com/?Action=ConfirmSubscription");
  });

  it("parses the SNS envelope from rawBody when the JSON parser did not run", async () => {
    mockFetch();
    const msg = baseNotification();
    msg.SigningCertURL = certUrl("rawbody");
    msg.Signature = signEnvelope(msg);
    const verdict = await carrier.verifyHook({
      headers: { "content-type": "text/plain; charset=UTF-8" },
      body: undefined,
      rawBody: JSON.stringify(msg),
    });
    expect(verdict).toEqual({ ok: true });
  });
});
