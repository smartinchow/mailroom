import Link from "next/link";
import { api, qs } from "@/lib/api";
import { ALL_STATUSES, formatDate } from "@/lib/format";
import { StatusChip } from "@/components/StatusChip";
import type { Domain, MessageList, Project } from "@/lib/types";

export const dynamic = "force-dynamic";

type Search = {
  projectId?: string;
  domain?: string;
  status?: string;
  template?: string;
  to?: string;
  q?: string;
  after?: string;
  before?: string;
  cursor?: string;
};

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const filters: Search = {
    projectId: one(raw.projectId),
    domain: one(raw.domain),
    status: one(raw.status),
    template: one(raw.template),
    to: one(raw.to),
    q: one(raw.q),
    after: one(raw.after),
    before: one(raw.before),
    cursor: one(raw.cursor),
  };

  const [list, projects, domains] = await Promise.all([
    api<MessageList>(
      `/messages${qs({
        projectId: filters.projectId,
        domain: filters.domain,
        status: filters.status,
        template: filters.template,
        to: filters.to,
        q: filters.q,
        after: filters.after,
        before: filters.before,
        cursor: filters.cursor,
        limit: 50,
      })}`,
    ),
    api<Project[]>("/projects"),
    api<Domain[]>("/domains"),
  ]);

  const olderHref = list.nextCursor
    ? `/messages${qs({ ...filters, cursor: list.nextCursor })}`
    : null;
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Messages</h1>

      <form method="get" className="card grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <label className="label" htmlFor="projectId">Project</label>
          <select id="projectId" name="projectId" defaultValue={filters.projectId ?? ""} className="input w-full">
            <option value="">All</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="domain">Domain</label>
          <select id="domain" name="domain" defaultValue={filters.domain ?? ""} className="input w-full">
            <option value="">All</option>
            {domains.map((d) => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""} className="input w-full">
            <option value="">All</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="template">Template tag</label>
          <input id="template" name="template" defaultValue={filters.template ?? ""} className="input w-full" placeholder="invite" />
        </div>
        <div>
          <label className="label" htmlFor="to">Recipient</label>
          <input id="to" name="to" defaultValue={filters.to ?? ""} className="input w-full" placeholder="a@b.com" />
        </div>
        <div>
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={filters.q ?? ""} className="input w-full" placeholder="subject, address…" />
        </div>
        <div>
          <label className="label" htmlFor="after">After</label>
          <input id="after" name="after" type="datetime-local" defaultValue={filters.after ?? ""} className="input w-full" />
        </div>
        <div>
          <label className="label" htmlFor="before">Before</label>
          <input id="before" name="before" type="datetime-local" defaultValue={filters.before ?? ""} className="input w-full" />
        </div>
        <div className="col-span-2 flex items-end gap-2 md:col-span-4">
          <button type="submit" className="btn-primary">Filter</button>
          {hasFilters && (
            <Link href="/messages" className="btn">Clear</Link>
          )}
        </div>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[880px] border-collapse">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="th">Time</th>
              <th className="th">Project</th>
              <th className="th">To</th>
              <th className="th">Subject</th>
              <th className="th">Template</th>
              <th className="th">Carrier</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.items.length === 0 && (
              <tr>
                <td className="td py-8 text-center text-zinc-500 dark:text-zinc-400" colSpan={7}>
                  No messages match.
                </td>
              </tr>
            )}
            {list.items.map((m) => (
              <tr
                key={m.id}
                className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40"
              >
                <td className="td whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                  <Link href={`/messages/${m.id}`} className="hover:underline">
                    {formatDate(m.queuedAt)}
                  </Link>
                </td>
                <td className="td font-mono text-xs">{m.projectSlug}</td>
                <td className="td max-w-[220px] truncate">{m.to.join(", ")}</td>
                <td className="td max-w-[280px]">
                  <Link href={`/messages/${m.id}`} className="block truncate font-medium hover:underline">
                    {m.subject}
                  </Link>
                </td>
                <td className="td font-mono text-xs">{m.tags?.template ?? "—"}</td>
                <td className="td font-mono text-xs">{m.carrierType}</td>
                <td className="td">
                  <StatusChip status={m.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        {filters.cursor && (
          <Link href={`/messages${qs({ ...filters, cursor: undefined })}`} className="btn">
            ← Newest
          </Link>
        )}
        {olderHref ? (
          <Link href={olderHref} className="btn">
            Older →
          </Link>
        ) : (
          <span className="text-sm text-zinc-400 dark:text-zinc-500">End of results</span>
        )}
      </div>
    </div>
  );
}
