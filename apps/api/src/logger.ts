import pino from "pino";
import { env } from "./env.js";

/**
 * Structured JSON logs keyed by messageId. Never log bodies: the redaction list
 * below is a backstop, not a licence to pass them in.
 */
/** Webhook URLs carry the endpoint secret as a path segment — mask it. */
function maskHookSecret(url: string): string {
  return url.replace(/(\/v1\/hooks\/[^/]+\/)[^/?]+/, "$1[secret]");
}

export const logger = pino({
  level: env().LOG_LEVEL,
  redact: {
    paths: ["bodyHtml", "bodyText", "html", "text", "*.bodyHtml", "*.bodyText", "*.html", "*.text"],
    censor: "[body omitted]",
  },
  serializers: {
    req(req: { method?: string; url?: string; [k: string]: unknown }) {
      return { method: req.method, url: req.url ? maskHookSecret(req.url) : undefined };
    },
  },
});
