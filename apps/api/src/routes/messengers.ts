import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireBasicApiKey } from "../auth.js";
import { handleSend, type SendInput } from "./emails.js";
import { logger } from "../logger.js";

/**
 * listmonk "postback" messenger endpoint (design: campaigns route through the
 * existing send pipeline, one mailroom Message per recipient). listmonk auths
 * postback messengers with optional HTTP Basic; here the password IS a mailroom
 * project API key (the same secret Bearer auth accepts), so setup is: point the
 * messenger at this URL with any username and a live/test key as the password.
 *
 * Contract (https://listmonk.app/docs/messengers/), POST body:
 *   { subject, content_type, body,
 *     recipients: [{ uuid, email, name, attribs, status }, ...],
 *     campaign: { uuid, name, tags } }
 * listmonk expects 200 on success and retries on any non-2xx.
 */

const listmonkRecipient = z.object({
  uuid: z.string().optional(),
  email: z.string().min(3),
  name: z.string().optional(),
  attribs: z.record(z.unknown()).optional(),
  status: z.string().optional(),
});

const listmonkPayload = z.object({
  subject: z.string().min(1),
  content_type: z.string().optional().default("plain"),
  body: z.string(),
  recipients: z.array(listmonkRecipient).min(1),
  campaign: z.object({
    uuid: z.string(),
    name: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
});

/**
 * Crude HTML -> text fallback so a plain-text alternative always exists.
 * Not a renderer -- good enough for the text/plain part of an otherwise-html send.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sha256 keeps the DB column short and collision-free regardless of email length. */
function idempotencyKeyFor(campaignUuid: string, email: string): string {
  return createHash("sha256").update(`listmonk:${campaignUuid}:${email.toLowerCase()}`).digest("hex");
}

export function registerMessengerRoutes(app: FastifyInstance): void {
  app.post("/v1/messengers/listmonk", async (req, reply) => {
    const ctx = await requireBasicApiKey(req, reply);
    if (!ctx) return;

    const parsed = listmonkPayload.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const payload = parsed.data;

    const q = req.query as Record<string, string | undefined>;
    const from = q.from;
    if (!from) {
      return reply
        .code(400)
        .send({ error: "from_required", detail: "listmonk postback carries no sender; pass ?from=<address>" });
    }
    const replyTo = q.reply_to;
    const cc = q.cc
      ? q.cc
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Only an explicit "html" content_type is treated as HTML; everything else
    // (plain, or an unrecognised value) goes to the text field untouched.
    const isHtml = payload.content_type.toLowerCase() === "html";
    const html = isHtml ? payload.body : undefined;
    const text = isHtml ? htmlToText(payload.body) : payload.body;
    const campaignTag = payload.campaign.name ?? payload.campaign.uuid;

    const results: Array<{ email: string; code: number }> = [];

    for (const recipient of payload.recipients) {
      const input: SendInput = {
        from,
        to: [recipient.email],
        subject: payload.subject,
        html,
        text,
        reply_to: replyTo,
        cc,
        bcc: [],
        headers: {},
        tags: { campaign: campaignTag, messenger: "listmonk" },
        attachments: [],
      };
      const idempotencyKey = idempotencyKeyFor(payload.campaign.uuid, recipient.email);

      try {
        const outcome = await handleSend(ctx.project, input, idempotencyKey);
        results.push({ email: recipient.email, code: outcome.code });
        if (outcome.code !== 202 && outcome.code !== 200 && outcome.code !== 409) {
          logger.warn(
            { code: outcome.code, body: outcome.body, recipient: recipient.email, campaign: payload.campaign.uuid },
            "listmonk postback: recipient rejected",
          );
        }
      } catch (e) {
        logger.error(
          { err: e, recipient: recipient.email, campaign: payload.campaign.uuid },
          "listmonk postback: send failed",
        );
        results.push({ email: recipient.email, code: 500 });
      }
    }

    // 409 (suppressed) counts as success from listmonk's perspective -- the
    // pipeline has already recorded the SUPPRESSED outcome; listmonk should not
    // retry it. Anything else that is not a successful send is a real failure,
    // so respond non-200 and let listmonk retry per its own policy.
    const hardFailure = results.some((r) => r.code !== 202 && r.code !== 200 && r.code !== 409);
    if (hardFailure) {
      return reply.code(502).send({ error: "send_failed", results });
    }

    return reply.code(200).send({ status: "ok" });
  });
}
