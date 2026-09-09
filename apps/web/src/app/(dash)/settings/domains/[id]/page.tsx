import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CopyButton } from "@/components/CopyButton";
import { DnsRecordStatusChip, DomainStatusChip } from "@/components/StatusChip";
import type { Carrier, Domain, Project, SenderUsername } from "@/lib/types";
import { deleteDomain, updateDomain, verifyDomain } from "../actions";
import { domainErrorMessage } from "../errorMessages";
import { DeleteDomainForm } from "../DeleteDomainForm";

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
      {!allowNone && (
        <option value="" disabled>
          Select…
        </option>
      )}
      {carriers.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type})
        </option>
      ))}
    </select>
  );
}

/** `Support <support@tintinpos.com>`, or the bare address when there is no display name. */
function formatSender(s: SenderUsername): string {
  return s.displayName ? `${s.displayName} <${s.username}>` : s.username;
}

async function fetchDomain(id: string): Promise<Domain | null> {
  try {
    return await api<Domain>(`/domains/${encodeURIComponent(id)}`);
  } catch (err) {
    // The admin API may not ship GET-by-id; fall back to filtering the list.
    if (err instanceof ApiError && err.status === 404) {
      const list = await api<Domain[]>("/domains");
      return list.find((d) => d.id === id) ?? null;
    }
    throw err;
  }
}

export default async function DomainDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const [domain, projects, carriers] = await Promise.all([
    fetchDomain(id),
    api<Project[]>("/projects"),
    api<Carrier[]>("/carriers"),
  ]);
  if (!domain) notFound();

  const errorMessage = domainErrorMessage(error);
  const senders = domain.sender_usernames ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings/domains"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← Domains
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{domain.name}</h1>
          <DomainStatusChip status={domain.status} />
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {domain.projectSlug ? `project: ${domain.projectSlug}` : "shared"} · carrier:{" "}
          {domain.carrier.name} ({domain.carrier.type})
          {domain.mail_from_domain ? ` · MAIL FROM: ${domain.mail_from_domain}` : ""}
        </p>
      </div>

      {errorMessage && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {errorMessage}
        </p>
      )}

      <section className="card">
        <h2 className="mb-3 text-base font-semibold">Verification</h2>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Verified at
            </dt>
            <dd className="mt-0.5 text-sm">{formatDate(domain.verified_at)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Last checked
            </dt>
            <dd className="mt-0.5 text-sm">{formatDate(domain.last_checked_at)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Verification error
            </dt>
            <dd className="mt-0.5 break-words text-sm">{domain.verification_error ?? "—"}</dd>
          </div>
        </dl>

        {domain.status === "failed" && (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            DNS records expire after 72h without verifying — click &quot;Verify DNS
            records&quot; to restart the verification window.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <form action={verifyDomain}>
            <input type="hidden" name="id" value={domain.id} />
            <button type="submit" className="btn-primary">
              Verify DNS records
            </button>
          </form>
          <DeleteDomainForm id={domain.id} name={domain.name} action={deleteDomain} />
        </div>

        <details className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <summary className="cursor-pointer text-sm font-medium">Edit</summary>
          <form action={updateDomain} className="mt-3 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={domain.id} />
            <div>
              <label className="label">Project</label>
              <ProjectSelect projects={projects} defaultValue={domain.project_id} />
            </div>
            {domain.records.length === 0 && (
              <div>
                <label className="label">Carrier</label>
                <CarrierSelect name="carrierId" carriers={carriers} defaultValue={domain.carrier.id} />
              </div>
            )}
            <div>
              <label className="label">Fallback carrier</label>
              <CarrierSelect
                name="fallbackCarrierId"
                carriers={carriers.filter((c) => c.id !== domain.carrier.id)}
                defaultValue={domain.fallbackCarrierId}
                allowNone
              />
            </div>
            <div>
              <label className="label">Notes</label>
              <input name="notes" defaultValue={domain.notes ?? ""} className="input w-full" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Sender addresses</label>
              <textarea
                name="senderUsernames"
                rows={4}
                defaultValue={senders.map(formatSender).join("\n")}
                placeholder={`support@${domain.name}\nSupport <support@${domain.name}>`}
                className="input w-full font-mono text-xs"
              />
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                One per line. Leave empty to use the carrier&apos;s own list.
              </p>
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className="btn-primary">
                Save changes
              </button>
            </div>
          </form>
        </details>
      </section>

      <section className="card">
        <h2 className="mb-1 text-base font-semibold">Sender addresses</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Registered with the carrier when the domain verifies. Azure Communication
          Services rejects a send from an address it was never told about, and only says
          so at send time — so an address missing here fails silently until someone
          sends. Removing one stops it sending. Edit the list under &quot;Edit&quot;
          above.
        </p>
        {senders.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            None set for this domain — the carrier&apos;s configured senders are used.
          </p>
        ) : (
          <ul className="space-y-1">
            {senders.map((s) => (
              <li key={s.username} className="font-mono text-sm">
                {formatSender(s)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="px-4 pt-4 text-base font-semibold">DNS records</h2>
        {domain.records.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
            This domain is on a manual carrier — no DNS records are provisioned by
            Mailroom.
          </p>
        ) : (
          <>
            <table className="mt-3 w-full min-w-[900px] border-collapse">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th className="th">Type</th>
                  <th className="th">Name</th>
                  <th className="th">Value</th>
                  <th className="th">Priority</th>
                  <th className="th">TTL</th>
                  <th className="th">Purpose</th>
                  <th className="th">Required</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {domain.records.map((r, i) => (
                  <tr
                    key={`${r.type}-${r.name}-${i}`}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
                  >
                    <td className="td font-mono text-xs">{r.type}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <code className="max-w-[260px] truncate rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
                          {r.name}
                        </code>
                        <CopyButton value={r.name} />
                      </div>
                      {r.type === "CNAME" && (
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          Cloudflare: set to <strong>DNS only</strong> (grey cloud) — not
                          proxied.
                        </p>
                      )}
                    </td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <code className="max-w-[260px] truncate rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
                          {r.value}
                        </code>
                        <CopyButton value={r.value} />
                      </div>
                    </td>
                    <td className="td text-sm">{r.priority ?? "—"}</td>
                    <td className="td text-sm">{r.ttl ?? "—"}</td>
                    <td className="td font-mono text-xs">{r.purpose}</td>
                    <td className="td text-sm">{r.required ? "yes" : "no"}</td>
                    <td className="td">
                      <DnsRecordStatusChip status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="p-4 pt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Publish these records at your DNS provider, then click &quot;Verify DNS
              records&quot;.
            </p>
          </>
        )}
      </section>

      {domain.notes && (
        <section className="card">
          <h2 className="mb-1 text-base font-semibold">Notes</h2>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{domain.notes}</p>
        </section>
      )}
    </div>
  );
}
