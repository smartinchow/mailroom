import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CopyButton } from "@/components/CopyButton";
import type { Carrier, HookUrls } from "@/lib/types";
import { createCarrier, toggleCarrier, updateCarrier } from "./actions";
import { ConfigFields, NewCarrierForm } from "./ConfigFields";

export const dynamic = "force-dynamic";

export default async function CarriersPage() {
  const [carriers, hookUrls] = await Promise.all([
    api<Carrier[]>("/carriers"),
    api<HookUrls>("/hook-urls"),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Carriers</h1>

      <section className="card">
        <h2 className="mb-1 text-base font-semibold">Event hook URLs</h2>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Point the provider&apos;s event stream here: Event Grid subscription (ACS) or the
          SNS topic&apos;s HTTPS subscription (SES). The secret is part of the path.
        </p>
        <div className="space-y-2">
          {(
            [
              ["ACS / Event Grid", hookUrls.acs],
              ["SES / SNS", hookUrls.ses],
            ] as const
          ).map(([label, url]) => (
            <div key={label} className="flex flex-wrap items-center gap-2">
              <span className="w-32 shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {label}
              </span>
              <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
                {url}
              </code>
              <CopyButton value={url} />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        {carriers.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No carriers yet.</p>
        )}
        {carriers.map((c) => (
          <div key={c.id} className="card">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {c.name}{" "}
                  <span className="ml-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                    {c.type}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {c.ratePerSecond}/s · {c.ratePerHour}/h · created {formatDate(c.createdAt)}
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  c.enabled
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                    : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                }`}
              >
                {c.enabled ? "enabled" : "disabled"}
              </span>
              <form action={toggleCarrier}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="enabled" value={String(!c.enabled)} />
                <button type="submit" className="btn px-2 py-1 text-xs">
                  {c.enabled ? "Disable" : "Enable"}
                </button>
              </form>
            </div>

            <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm font-medium">Edit</summary>
              <form action={updateCarrier} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="type" value={c.type} />
                <div>
                  <label className="label">Name</label>
                  <input name="name" defaultValue={c.name} required className="input w-full" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Rate / second</label>
                    <input name="ratePerSecond" type="number" min={1} defaultValue={c.ratePerSecond} className="input w-full" />
                  </div>
                  <div>
                    <label className="label">Rate / hour</label>
                    <input name="ratePerHour" type="number" min={1} defaultValue={c.ratePerHour} className="input w-full" />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                    Credentials are write-only — they are never shown here. Leave the fields
                    below blank to keep the existing configuration; fill them all to replace it.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ConfigFields type={c.type} required={false} />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <button type="submit" className="btn-primary">Save changes</button>
                </div>
              </form>
            </details>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="mb-3 text-base font-semibold">Add carrier</h2>
        <NewCarrierForm action={createCarrier} />
      </section>
    </div>
  );
}
