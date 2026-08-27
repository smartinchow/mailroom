import Link from "next/link";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { StatusChip } from "@/components/StatusChip";
import type { MessageDetail } from "@/lib/types";
import { BodyPreview } from "./BodyPreview";

export const dynamic = "force-dynamic";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export default async function MessageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await api<MessageDetail>(`/messages/${encodeURIComponent(id)}`);
  const m = detail.message;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/messages" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          ← Messages
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{m.subject}</h1>
          <StatusChip status={m.status} />
        </div>
        <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">{m.id}</p>
      </div>

      <section className="card">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="From">{m.from}</Field>
          <Field label="To">{m.to.join(", ")}</Field>
          {m.cc.length > 0 && <Field label="Cc">{m.cc.join(", ")}</Field>}
          {m.bcc.length > 0 && <Field label="Bcc">{m.bcc.join(", ")}</Field>}
          {m.replyTo && <Field label="Reply-To">{m.replyTo}</Field>}
          <Field label="Queued">{formatDate(m.queuedAt)}</Field>
          <Field label="Sent">{formatDate(m.sentAt)}</Field>
          <Field label="Last event">{formatDate(m.lastEventAt)}</Field>
          <Field label="Attempts">{m.attempts}</Field>
          <Field label="Provider message id">
            <span className="font-mono text-xs">{m.providerMessageId ?? "—"}</span>
          </Field>
          {m.idempotencyKey && (
            <Field label="Idempotency key">
              <span className="font-mono text-xs">{m.idempotencyKey}</span>
            </Field>
          )}
          {m.lastError && (
            <Field label="Last error">
              <span className="text-red-600 dark:text-red-400">{m.lastError}</span>
            </Field>
          )}
        </dl>

        {Object.keys(m.tags ?? {}).length > 0 && (
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <p className="label">Tags</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(m.tags).map(([k, v]) => (
                <span
                  key={k}
                  className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800"
                >
                  {k}={String(v)}
                </span>
              ))}
            </div>
          </div>
        )}

        {Object.keys(m.headers ?? {}).length > 0 && (
          <details className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <summary className="cursor-pointer text-sm font-medium">
              Headers ({Object.keys(m.headers).length})
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-800">
              {JSON.stringify(m.headers, null, 2)}
            </pre>
          </details>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">Body</h2>
        <BodyPreview
          bodyHtml={detail.bodyHtml}
          bodyText={detail.bodyText}
          bodyPurgedAt={detail.bodyPurgedAt}
          redactedLinkCount={detail.redactedLinkCount}
        />
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">Events</h2>
        {detail.events.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No events yet.</p>
        ) : (
          <ol className="space-y-2">
            {detail.events.map((e, i) => (
              <li key={`${e.type}-${e.occurredAt}-${i}`} className="card py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-sm font-semibold">{e.type}</span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    {formatDate(e.occurredAt)}
                  </span>
                  {e.recipient && (
                    <span className="text-sm text-zinc-600 dark:text-zinc-300">
                      → {e.recipient}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
                    received {formatDate(e.receivedAt)}
                  </span>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-zinc-500 dark:text-zinc-400">
                    Provider raw JSON
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-800">
                    {JSON.stringify(e.providerRaw, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
