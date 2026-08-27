import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const messagesTotal = new client.Counter({
  name: "mailroom_messages_total",
  help: "Messages by carrier and final status transition",
  labelNames: ["carrier", "status"] as const,
  registers: [registry],
});

export const sendDuration = new client.Histogram({
  name: "mailroom_send_duration_seconds",
  help: "Carrier send() latency",
  labelNames: ["carrier"] as const,
  registers: [registry],
});

export const queueDepth = new client.Gauge({
  name: "mailroom_queue_depth",
  help: "Jobs waiting per queue",
  labelNames: ["queue"] as const,
  registers: [registry],
});

export const eventLag = new client.Histogram({
  name: "mailroom_event_lag_seconds",
  help: "Seconds between provider occurredAt and ingest",
  labelNames: ["carrier"] as const,
  buckets: [1, 5, 15, 60, 300, 1800, 7200],
  registers: [registry],
});

export const suppressionsTotal = new client.Counter({
  name: "mailroom_suppressions_total",
  help: "Suppressions added by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});
