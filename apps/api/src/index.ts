import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { registerEmailRoutes } from "./routes/emails.js";
import { registerMessengerRoutes } from "./routes/messengers.js";
import { registerDomainRoutes } from "./routes/domains.js";
import { registerHookRoutes } from "./routes/hooks.js";
import { registerSuppressionRoutes } from "./routes/suppressions.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerHealthRoutes } from "./routes/health.js";
import { startWorkers } from "./worker.js";
import { scheduleMaintenance } from "./queue.js";

async function main(): Promise<void> {
  // Cast: pino's Logger satisfies Fastify's runtime contract; the generic
  // instantiation it produces just doesn't unify with FastifyBaseLogger.
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  }) as unknown as FastifyInstance;

  registerHealthRoutes(app);
  registerEmailRoutes(app);
  registerMessengerRoutes(app);
  registerDomainRoutes(app);
  registerHookRoutes(app);
  registerSuppressionRoutes(app);
  registerAdminRoutes(app);

  const workers = startWorkers();
  await scheduleMaintenance();

  const close = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await workers.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void close("SIGTERM"));
  process.on("SIGINT", () => void close("SIGINT"));

  await app.listen({ port: env().PORT, host: "0.0.0.0" });
  logger.info({ port: env().PORT }, "mailroom-api listening");
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
