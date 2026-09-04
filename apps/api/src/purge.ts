import { prisma } from "./db.js";
import { logger } from "./logger.js";

/**
 * Nightly purge (design §10.3): null bodies older than the project's
 * bodyRetentionDays, stamp bodyPurgedAt. Metadata and events are kept.
 */
export async function purgeExpiredBodies(): Promise<number> {
  const projects = await prisma.project.findMany();
  let total = 0;
  for (const project of projects) {
    const cutoff = new Date(Date.now() - project.bodyRetentionDays * 24 * 3600 * 1000);
    const result = await prisma.message.updateMany({
      where: {
        projectId: project.id,
        queuedAt: { lt: cutoff },
        bodyPurgedAt: null,
        OR: [{ bodyHtml: { not: null } }, { bodyText: { not: null } }],
      },
      data: { bodyHtml: null, bodyText: null, bodyPurgedAt: new Date() },
    });
    total += result.count;
  }
  if (total > 0) logger.info({ purged: total }, "retention purge complete");
  return total;
}
