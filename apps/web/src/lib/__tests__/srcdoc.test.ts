import { describe, expect, it } from "vitest";
import { buildBodySrcdoc } from "../srcdoc";

describe("buildBodySrcdoc (security-critical rendering, design §9.4)", () => {
  it("injects a CSP meta with default-src 'none'", () => {
    const doc = buildBodySrcdoc("<p>hi</p>", false);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
  });

  it("blocks remote images by default", () => {
    const doc = buildBodySrcdoc('<img src="https://t.example/pixel.gif">', false);
    expect(doc).toContain("img-src 'none'");
    expect(doc).not.toContain("img-src https:");
  });

  it("allows only https images after explicit opt-in", () => {
    const doc = buildBodySrcdoc('<img src="https://cdn.example/logo.png">', true);
    expect(doc).toContain("img-src https: data:");
    expect(doc).not.toContain("img-src 'none'");
  });

  it("never allows scripts via CSP", () => {
    for (const allowImages of [false, true]) {
      const doc = buildBodySrcdoc("<script>alert(1)</script>", allowImages);
      expect(doc).not.toContain("script-src 'unsafe-inline'");
      expect(doc).not.toContain("allow-scripts");
      expect(doc.startsWith("<!doctype html>")).toBe(true);
    }
  });

  it("is base-less (relative URLs resolve nowhere)", () => {
    const doc = buildBodySrcdoc("<p>x</p>", false);
    expect(doc).not.toContain("<base");
  });

  it("embeds the body html verbatim", () => {
    const html = '<table><tr><td style="color:red">cell</td></tr></table>';
    expect(buildBodySrcdoc(html, false)).toContain(html);
  });
});
