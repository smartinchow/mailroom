import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Carrier, Domain, Project } from "@/lib/types";
import { createDomain, deleteDomain, updateDomain } from "./actions";

export const dynamic = "force-dynamic";

function ProjectSelect({
  projects,
  defaultValue,
}: {
  projects: Project[];
  defaultValue?: string | null;
}) {
  return (
    <select name="projectId" defaultValue={defaultValue ?? ""} className="input w-full">
      <option value="">Shared (all projects)</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function CarrierSelect({
  name,
  carriers,
  defaultValue,
  allowNone,
}: {
  name: string;
  carriers: Carrier[];
  defaultValue?: string | null;
  allowNone?: boolean;
}) {
  return (
    <select name={name} defaultValue={defaultValue ?? ""} className="input w-full" required={!allowNone}>
      {allowNone && <option value="">None</option>}
      {!allowNone && <option value="" disabled>Select…</option>}
      {carriers.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type})
        </option>
      ))}
    </select>
  );
}

export default async function DomainsPage() {
  const [domains, projects, carriers] = await Promise.all([
    api<Domain[]>("/domains"),
    api<Project[]>("/projects"),
    api<Carrier[]>("/carriers"),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Domains</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Each sending domain routes to a carrier. A key may only send from its
        project&apos;s domains; a domain without a project is shared.
      </p>

      <section className="space-y-3">
        {domains.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No domains yet.</p>
        )}
        {domains.map((d) => (
          <div key={d.id} className="card">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm font-semibold">{d.name}</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {d.projectSlug ? `project: ${d.projectSlug}` : "shared"} · carrier: {d.carrierName}
                  {d.verifiedAt ? ` · verified ${formatDate(d.verifiedAt)}` : " · not verified"}
                </p>
                {d.notes && (
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{d.notes}</p>
                )}
              </div>
              <form
                action={deleteDomain}
              >
                <input type="hidden" name="id" value={d.id} />
                <button type="submit" className="btn-danger">Delete</button>
              </form>
            </div>

            <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm font-medium">Edit</summary>
              <form action={updateDomain} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={d.id} />
                <div>
                  <label className="label">Project</label>
                  <ProjectSelect projects={projects} defaultValue={d.projectId} />
                </div>
                <div>
                  <label className="label">Carrier</label>
                  <CarrierSelect name="carrierId" carriers={carriers} defaultValue={d.carrierId} />
                </div>
                <div>
                  <label className="label">Fallback carrier</label>
                  <CarrierSelect
                    name="fallbackCarrierId"
                    carriers={carriers.filter((c) => c.id !== d.carrierId)}
                    defaultValue={d.fallbackCarrierId}
                    allowNone
                  />
                </div>
                <div>
                  <label className="label">Notes</label>
                  <input name="notes" defaultValue={d.notes ?? ""} className="input w-full" />
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
        <h2 className="mb-3 text-base font-semibold">Add domain</h2>
        <form action={createDomain} className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Domain name</label>
            <input name="name" required className="input w-full" placeholder="mail.example.com" />
          </div>
          <div>
            <label className="label">Project</label>
            <ProjectSelect projects={projects} />
          </div>
          <div>
            <label className="label">Carrier</label>
            <CarrierSelect name="carrierId" carriers={carriers} />
          </div>
          <div>
            <label className="label">Fallback carrier</label>
            <CarrierSelect name="fallbackCarrierId" carriers={carriers} allowNone />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <input name="notes" className="input w-full" placeholder="optional" />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className="btn-primary">Add domain</button>
          </div>
        </form>
      </section>
    </div>
  );
}
