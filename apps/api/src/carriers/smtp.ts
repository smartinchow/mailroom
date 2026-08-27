import nodemailer from "nodemailer";
import type { Carrier, OutboundMessage, SmtpConfig } from "./types.js";

/**
 * SMTP escape hatch (and Mailpit in development). No event stream — status
 * stops at SENT and the dashboard says so rather than implying delivery.
 */
export function createSmtpCarrier(config: SmtpConfig): Carrier {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
  });

  return {
    type: "smtp",

    async send(msg: OutboundMessage) {
      const info = await transport.sendMail({
        from: msg.from,
        to: msg.to,
        cc: msg.cc.length ? msg.cc : undefined,
        bcc: msg.bcc.length ? msg.bcc : undefined,
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: msg.headers,
        attachments: msg.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: Buffer.from(a.content, "base64"),
        })),
      });
      return { providerMessageId: info.messageId ?? `smtp-${msg.id}` };
    },

    async verifyHook() {
      return { ok: false, reason: "smtp carrier has no event hook" };
    },

    parseEvents() {
      return [];
    },
  };
}
