import Link from "next/link";
import { api } from "@/lib/api";
import { ALL_STATUSES, formatDate } from "@/lib/format";
import type { Overview } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const overview = await api<Overview>("/overview");

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Last 24 hours</p>
      </div>

      <section>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {ALL_STATUSES.map((status) => (
            <Link
              key={status}
              href={`/messages?status=${status}`}
              className="card block hover:border-zinc-400 dark:hover:border-zinc-600"
            >
              <p className="text-2xl font-semibold tabular-nums">
                {overview.last24h[status] ?? 0}
              </p>
              <p className="mt-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {status}
              </p>
            </Link>
          ))}
          <div className="card">
            <p className="text-2xl font-semibold tabular-nums">{overview.queueDepth}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Queue depth
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">Carriers</h2>
        {overview.carriers.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No carriers configured yet.{" "}
            <Link className="underline" href="/settings/carriers">
              Add one
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {overview.carriers.map((c) => (
              <div key={c.id} className="card">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-medium">{c.name}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      c.enabled
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    {c.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <dl className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                  <div className="flex justify-between">
                    <dt>Type</dt>
                    <dd className="font-mono text-xs">{c.type}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Rate / hour</dt>
                    <dd className="tabular-nums">{c.ratePerHour}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Last send</dt>
                    <dd>{formatDate(c.lastSendAt)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Recent failures</dt>
                    <dd
                      className={`tabular-nums ${
                        c.recentFailures > 0 ? "font-semibold text-red-600 dark:text-red-400" : ""
                      }`}
                    >
                      {c.recentFailures}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
