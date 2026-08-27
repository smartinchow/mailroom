import type { SuppressionReason } from "@prisma/client";
import { prisma } from "./db.js";

/**
 * Estate-wide suppression (design §2 goal 6). Scope "GLOBAL" or a domain name.
 * A hard bounce on one project protects every project.
 */

export async function isSuppressed(address: string, domain: string): Promise<boolean> {
  const addr = address.toLowerCase();
  const now = new Date();
  const hit = await prisma.suppression.findFirst({
    where: {
      address: addr,
      scope: { in: ["GLOBAL", domain.toLowerCase()] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  return hit != null;
}

export async function addSuppression(params: {
  address: string;
  reason: SuppressionReason;
  scope?: string;
  messageId?: string;
  expiresAt?: Date;
}): Promise<void> {
  const address = params.address.toLowerCase();
  const scope = (params.scope ?? "GLOBAL").toLowerCase() === "global" ? "GLOBAL" : params.scope!.toLowerCase();
  await prisma.suppression.upsert({
    where: { address_scope: { address, scope } },
    create: {
      address,
      scope,
      reason: params.reason,
      messageId: params.messageId,
      expiresAt: params.expiresAt,
    },
    update: { reason: params.reason, messageId: params.messageId, expiresAt: params.expiresAt },
  });
}
