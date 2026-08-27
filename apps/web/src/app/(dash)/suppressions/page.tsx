import Link from "next/link";
import { api, qs } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { SuppressionList } from "@/lib/types";
import { addSuppression, removeSuppression } from "./actions";

export const dynamic = "force-dynamic";

const REASON_LABEL: Record<string, string> = {
  HARD_BOUNCE: "Hard bounce",
  COMPLAINT: "Complaint",
  MANUAL: "Manual",
};

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const { q, cursor } = await searchParams;
  const list = await api<SuppressionList>(`/suppressions${qs({ q, cursor })}`);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Suppressions</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Estate-wide block list. A hard bounce on one project protects every project.
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <form method="get" className="card lg:col-span-2">
          <label className="label" htmlFor="q">Search address</label>
          <div className="flex gap-2">
            <input id="q" name="q" defaultValue={q ?? ""} className="input flex-1" placeholder="user@example.com" />
            <button type="submit" className="btn-primary">Search</button>
            {q && <Link href="/suppressions" className="btn">Clear</Link>}
          </div>
        </form>

        <form action={addSuppression} className="card">
          <p className="label">Add manual suppression</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              name="address"
              type="email"
              required
              className="input flex-1"
              placeholder="user@example.com"
            />
            <input
              name="scope"
              className="input w-full sm:w-36"
              placeholder="GLOBAL"
              title="Leave blank for GLOBAL, or enter a domain name to scope the block"
            />
            <button type="submit" className="btn-primary">Add</button>
          </div>
        </form>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[720px] border-collapse">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="th">Address</th>
              <th className="th">Scope</th>
              <th className="th">Reason</th>
              <th className="th">Source message</th>
              <th className="th">Created</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {list.items.length === 0 && (
              <tr>
                <td className="td py-8 text-center text-zinc-500 dark:text-zinc-400" colSpan={6}>
                  No suppressions{q ? " match" : ""}.
                </td>
              </tr>
            )}
            {list.items.map((s) => (
              <tr key={s.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                <td className="td font-mono text-xs">{s.address}</td>
                <td className="td font-mono text-xs">{s.scope}</td>
                <td className="td">{REASON_LABEL[s.reason] ?? s.reason}</td>
                <td className="td">
                  {s.messageId ? (
                    <Link href={`/messages/${s.messageId}`} className="font-mono text-xs hover:underline">
                      {s.messageId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="td whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                  {formatDate(s.createdAt)}
                </td>
                <td className="td text-right">
                  <form action={removeSuppression}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" className="btn-danger">Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        {cursor && (
          <Link href={`/suppressions${qs({ q })}`} className="btn">← Newest</Link>
        )}
        {list.nextCursor ? (
          <Link href={`/suppressions${qs({ q, cursor: list.nextCursor })}`} className="btn">
            Older →
          </Link>
        ) : (
          <span className="text-sm text-zinc-400 dark:text-zinc-500">End of results</span>
        )}
      </div>
    </div>
  );
}
