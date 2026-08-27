"use client";

import { useState, useTransition } from "react";
import { CopyButton } from "@/components/CopyButton";
import type { CreatedKey } from "@/lib/types";

/**
 * API key creation flow. The plaintext key is returned exactly once by the
 * server action and lives only in this component's state until dismissed.
 */
export function NewKeyDialog({
  projectId,
  projectName,
  createAction,
}: {
  projectId: string;
  projectName: string;
  createAction: (projectId: string, name: string) => Promise<CreatedKey>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const close = () => {
    setOpen(false);
    setCreated(null);
    setName("");
    setError(null);
  };

  return (
    <>
      <button type="button" className="btn px-2 py-1 text-xs" onClick={() => setOpen(true)}>
        New API key
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-lg">
            {!created ? (
              <>
                <h3 className="mb-1 text-base font-semibold">
                  New API key — {projectName}
                </h3>
                <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
                  The key is shown once, immediately after creation. Store it in the
                  consuming application&apos;s secret manager.
                </p>
                {error && (
                  <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                    {error}
                  </p>
                )}
                <label className="label" htmlFor={`keyname-${projectId}`}>
                  Key name
                </label>
                <input
                  id={`keyname-${projectId}`}
                  className="input mb-4 w-full"
                  placeholder="production"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={pending}
                />
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn" onClick={close} disabled={pending}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={pending || name.trim().length === 0}
                    onClick={() =>
                      startTransition(async () => {
                        try {
                          setError(null);
                          const key = await createAction(projectId, name.trim());
                          setCreated(key);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Key creation failed");
                        }
                      })
                    }
                  >
                    {pending ? "Creating…" : "Create key"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="mb-2 text-base font-semibold">API key created</h3>
                <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  Copy it now — this key will never be shown again.
                </p>
                <div className="mb-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-zinc-100 px-2 py-2 text-xs dark:bg-zinc-800">
                    {created.plaintext}
                  </code>
                  <CopyButton value={created.plaintext} />
                </div>
                <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
                  Prefix <code>{created.prefix}</code> · key id{" "}
                  <code>{created.id}</code> (keep the id if you ever need to revoke it).
                </p>
                <div className="flex justify-end">
                  <button type="button" className="btn-primary" onClick={close}>
                    Done — I copied it
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
