import { describe, expect, it } from "vitest";
import { applyBodyPolicy, redactHtml, redactText, redactUrl } from "../redactor.js";

describe("redactUrl", () => {
  it("strips token-bearing query params", () => {
    const r = redactUrl("https://app.example.com/verify?token=abc123&keep=1");
    expect(r.value).toBe("https://app.example.com/verify?token=redacted&keep=1");
    expect(r.count).toBe(1);
  });

  it("covers the whole token param list, case-insensitively", () => {
    const r = redactUrl("https://x.io/a?Token=1&CODE=2&key=3&t=4&sig=5&secret=6&ok=7");
    expect(r.count).toBe(6);
    expect(r.value).toContain("ok=7");
    expect(r.value).not.toMatch(/=(1|2|3|4|5|6)(&|$)/);
  });

  it("replaces high-entropy path segments (>=20 chars base64url)", () => {
    const r = redactUrl("https://app.example.com/invite/dGhpc2lzYXNlY3JldHRva2VuMTIz/accept");
    expect(r.value).toBe("https://app.example.com/invite/[redacted]/accept");
    expect(r.count).toBe(1);
  });

  it("replaces hex tokens in paths", () => {
    const r = redactUrl("https://x.io/reset/8f14e45fceea167a5a36dedd4bea2543");
    expect(r.count).toBe(1);
    expect(r.value).not.toContain("8f14e45fceea167a5a36dedd4bea2543");
  });

  it("leaves ordinary URLs alone", () => {
    const url = "https://example.com/docs/getting-started?page=2";
    expect(redactUrl(url)).toEqual({ value: url, count: 0 });
  });

  it("leaves non-URLs alone", () => {
    expect(redactUrl("not a url").count).toBe(0);
  });
});

describe("redactHtml", () => {
  it("rewrites hrefs but preserves link text", () => {
    const html = `<a href="https://a.io/magic?token=SECRET123">Click here to sign in</a>`;
    const r = redactHtml(html);
    expect(r.value).toContain("Click here to sign in");
    expect(r.value).toContain("token=redacted");
    expect(r.value).not.toContain("SECRET123");
    expect(r.count).toBe(1);
  });

  it("handles single quotes and multiple links", () => {
    const html = `<a href='https://a.io/x?sig=abc'>one</a><a href="https://a.io/plain">two</a>`;
    const r = redactHtml(html);
    expect(r.count).toBe(1);
    expect(r.value).toContain("https://a.io/plain");
  });
});

describe("redactText", () => {
  it("rewrites bare URLs in plain text", () => {
    const r = redactText("Reset here: https://a.io/reset?token=tok123 thanks");
    expect(r.value).toContain("token=redacted");
    expect(r.count).toBe(1);
  });
});

describe("applyBodyPolicy", () => {
  const html = `<a href="https://a.io/m?token=zzz">go</a>`;

  it("NONE stores nothing", () => {
    expect(applyBodyPolicy({ bodyRetention: "NONE", html, text: "x" })).toEqual({
      bodyHtml: null,
      bodyText: null,
      redactedLinkCount: 0,
    });
  });

  it("FULL stores verbatim", () => {
    const r = applyBodyPolicy({ bodyRetention: "FULL", html });
    expect(r.bodyHtml).toBe(html);
    expect(r.redactedLinkCount).toBe(0);
  });

  it("REDACTED redacts and counts across html and text", () => {
    const r = applyBodyPolicy({
      bodyRetention: "REDACTED",
      html,
      text: "https://a.io/m?token=zzz",
    });
    expect(r.bodyHtml).not.toContain("zzz");
    expect(r.bodyText).not.toContain("zzz");
    expect(r.redactedLinkCount).toBe(2);
  });
});
