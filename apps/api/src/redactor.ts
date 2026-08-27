/**
 * Body redaction (D-06). Stored HTML embeds live credentials — magic links,
 * invite/share tokens. Rewrite token-bearing URL components before anything
 * touches the database. Visible link text is preserved; only URLs change.
 */

const TOKEN_PARAMS = new Set(["token", "code", "key", "t", "sig", "secret"]);

/** A path segment that looks like a credential: >=20 chars of base64url/hex alphabet. */
const HIGH_ENTROPY_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;

export interface RedactionResult {
  value: string;
  count: number;
}

/** Redact one URL. Returns the rewritten URL and how many substitutions were made. */
export function redactUrl(url: string): RedactionResult {
  let count = 0;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { value: url, count: 0 };
  }

  for (const name of [...parsed.searchParams.keys()]) {
    if (TOKEN_PARAMS.has(name.toLowerCase())) {
      parsed.searchParams.set(name, "redacted");
      count++;
    }
  }

  const segments = parsed.pathname.split("/");
  const rewritten = segments.map((seg) => {
    if (HIGH_ENTROPY_SEGMENT.test(seg)) {
      count++;
      return "[redacted]";
    }
    return seg;
  });
  if (count > 0) parsed.pathname = rewritten.join("/");

  return { value: parsed.toString(), count };
}

/** Redact every href attribute in an HTML body. */
export function redactHtml(html: string): RedactionResult {
  let count = 0;
  const value = html.replace(
    /(href\s*=\s*)(["'])(.*?)\2/gis,
    (_m, pre: string, quote: string, url: string) => {
      const r = redactUrl(url);
      count += r.count;
      return `${pre}${quote}${r.value}${quote}`;
    },
  );
  return { value, count };
}

/** Redact bare URLs in a plain-text body. */
export function redactText(text: string): RedactionResult {
  let count = 0;
  const value = text.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
    const r = redactUrl(url);
    count += r.count;
    return r.value;
  });
  return { value, count };
}

export interface BodyPolicyInput {
  bodyRetention: "NONE" | "REDACTED" | "FULL";
  html?: string;
  text?: string;
}

export interface StoredBody {
  bodyHtml: string | null;
  bodyText: string | null;
  redactedLinkCount: number;
}

/** Apply a project's retention policy at write time. */
export function applyBodyPolicy(input: BodyPolicyInput): StoredBody {
  if (input.bodyRetention === "NONE") {
    return { bodyHtml: null, bodyText: null, redactedLinkCount: 0 };
  }
  if (input.bodyRetention === "FULL") {
    return { bodyHtml: input.html ?? null, bodyText: input.text ?? null, redactedLinkCount: 0 };
  }
  let count = 0;
  let bodyHtml: string | null = null;
  let bodyText: string | null = null;
  if (input.html != null) {
    const r = redactHtml(input.html);
    bodyHtml = r.value;
    count += r.count;
  }
  if (input.text != null) {
    const r = redactText(input.text);
    bodyText = r.value;
    count += r.count;
  }
  return { bodyHtml, bodyText, redactedLinkCount: count };
}
