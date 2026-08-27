import { afterEach, describe, expect, it, vi } from "vitest";
import { createMailroom, MailroomError } from "../index.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mailroom = () => createMailroom({ url: "https://mailroom.example.test", apiKey: "mr_live_test123" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("send", () => {
  it("POSTs the snake_case wire body to /v1/emails with a Bearer token and returns { id, status }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { id: "01JTEST", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mailroom().send({
      from: "AMLify <noreply@amlify.au>",
      to: ["a@b.com"],
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: "support@amlify.au",
      tags: { template: "invite" },
    });

    expect(result).toEqual({ id: "01JTEST", status: "queued" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://mailroom.example.test/v1/emails");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer mr_live_test123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Idempotency-Key"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("AMLify <noreply@amlify.au>");
    expect(body.to).toEqual(["a@b.com"]);
    expect(body.reply_to).toBe("support@amlify.au");
    expect(body.replyTo).toBeUndefined();
    expect(body.tags).toEqual({ template: "invite" });
  });

  it("normalizes a single string `to` (and cc/bcc) into arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { id: "01JTEST", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    await mailroom().send({
      from: "noreply@amlify.au",
      to: "solo@example.com",
      cc: "copy@example.com",
      subject: "One recipient",
      text: "hi",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["solo@example.com"]);
    expect(body.cc).toEqual(["copy@example.com"]);
    expect(body.bcc).toBeUndefined();
  });

  it("passes idempotencyKey through as the Idempotency-Key header, not in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "01JTEST", status: "sent" }));
    vi.stubGlobal("fetch", fetchMock);

    await mailroom().send({
      from: "noreply@amlify.au",
      to: "a@b.com",
      subject: "Replayed",
      text: "hi",
      idempotencyKey: "invite-42",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers["Idempotency-Key"]).toBe("invite-42");
    const body = JSON.parse(init.body as string);
    expect(body.idempotencyKey).toBeUndefined();
    expect(body.idempotency_key).toBeUndefined();
  });

  it("throws MailroomError with the HTTP status and parsed error body on non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "suppressed", address: "bounced@example.com" }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = mailroom().send({
      from: "noreply@amlify.au",
      to: "bounced@example.com",
      subject: "Nope",
      text: "hi",
    });

    await expect(promise).rejects.toBeInstanceOf(MailroomError);
    const error = (await promise.catch((e: unknown) => e)) as MailroomError;
    expect(error.status).toBe(409);
    expect(error.body).toEqual({ error: "suppressed", address: "bounced@example.com" });
    expect(error.message).toContain("409");
    expect(error.message).toContain("suppressed");
  });
});
