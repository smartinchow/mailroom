import Link from "next/link";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { DomainStatusChip } from "@/components/StatusChip";
import type { Carrier, Domain, Project } from "@/lib/types";
import { createDomain } from "./actions";
import { domainErrorMessage } from "./errorMessages";

export const dynamic = "force-dynamic";

function ProjectSelect({ projects }: { projects: Project[] }) {
  return (
    <select name="projectId" defaultValue="" className="input w-full">
      <option value="">Shared (all projects)</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function CarrierSelect({ carriers }: { carriers: Carrier[] }) {
  const defaultCarrier = carriers.find((c) => c.isDefault);
  return (
    <select name="carrierId" defaultValue={defaultCarrier?.id ?? ""} className="input w-full">
      {!defaultCarrier && (
        <option value="" disabled>
          Select…
        </option>
      )}
      {carriers.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type})
          {c.isDefault ? " — default" : ""}
        </option>
      ))}
    </select>
  );
}

export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const [domains, projects, carriers] = await Promise.all([
    api<Domain[]>("/domains"),
    api<Project[]>("/projects"),
    api<Carrier[]>("/carriers"),
  ]);

  const errorMessage = domainErrorMessage(error);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Domains</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Each sending domain routes to a carrier. A key may only send from its
        project&apos;s domains; a domain without a project is shared.
      </p>

      {errorMessage && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {errorMessage}
        </p>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[720px] border-collapse">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="th">Domain</th>
              <th className="th">Project</th>
              <th className="th">Carrier</th>
              <th className="th">Status</th>
              <th className="th">Created</th>
            </tr>
          </thead>
          <tbody>
            {domains.length === 0 && (
              <tr>
                <td className="td py-8 text-center text-zinc-500 dark:text-zinc-400" colSpan={5}>
                  No domains yet.
                </td>
              </tr>
            )}
            {domains.map((d) => (
              <tr
                key={d.id}
                className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40"
              >
                <td className="td">
                  <Link
                    href={`/settings/domains/${d.id}`}
                    className="font-mono text-sm font-semibold hover:underline"
                  >
                    {d.name}
                  </Link>
                </td>
                <td className="td text-sm">{d.projectSlug ?? "shared"}</td>
                <td className="td text-sm">{d.carrier.name}</td>
                <td className="td">
                  <DomainStatusChip status={d.status} />
                </td>
                <td className="td whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                  {formatDate(d.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
            <CarrierSelect carriers={carriers} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <input name="notes" className="input w-full" placeholder="optional" />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className="btn-primary">
              Add domain
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
