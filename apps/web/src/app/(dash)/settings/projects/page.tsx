import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Project } from "@/lib/types";
import { createApiKey, createProject, revokeApiKey, updateProject } from "./actions";
import { NewKeyDialog } from "./NewKeyDialog";

export const dynamic = "force-dynamic";

const RETENTION_HELP: Record<Project["bodyRetention"], string> = {
  NONE: "no bodies stored",
  REDACTED: "bodies stored with tokens redacted (default)",
  FULL: "verbatim bodies — deliberate choice only",
};

export default async function ProjectsPage() {
  const projects = await api<Project[]>("/projects");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Projects</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        One project per application (or per app-environment). API keys are scoped to a
        project and can only send from that project&apos;s domains.
      </p>

      <section className="space-y-3">
        {projects.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No projects yet.</p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="card">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {p.name}{" "}
                  <span className="ml-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                    {p.slug}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  retention: {p.bodyRetention.toLowerCase()} / {p.bodyRetentionDays}d
                  {p.hourlyCap ? ` · cap ${p.hourlyCap}/h` : ""} · {p.keyCount} key
                  {p.keyCount === 1 ? "" : "s"} · {p.domainCount} domain
                  {p.domainCount === 1 ? "" : "s"} · created {formatDate(p.createdAt)}
                </p>
              </div>
              <NewKeyDialog projectId={p.id} projectName={p.name} createAction={createApiKey} />
            </div>

            <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm font-medium">Edit</summary>
              <form action={updateProject} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={p.id} />
                <div>
                  <label className="label">Name</label>
                  <input name="name" defaultValue={p.name} required className="input w-full" />
                </div>
                <div>
                  <label className="label">Hourly cap (blank = none)</label>
                  <input
                    name="hourlyCap"
                    type="number"
                    min={1}
                    defaultValue={p.hourlyCap ?? ""}
                    className="input w-full"
                  />
                </div>
                <div>
                  <label className="label">Body retention</label>
                  <select name="bodyRetention" defaultValue={p.bodyRetention} className="input w-full">
                    <option value="NONE">none — {RETENTION_HELP.NONE}</option>
                    <option value="REDACTED">redacted — {RETENTION_HELP.REDACTED}</option>
                    <option value="FULL">full — {RETENTION_HELP.FULL}</option>
                  </select>
                </div>
                <div>
                  <label className="label">Retention days</label>
                  <input
                    name="bodyRetentionDays"
                    type="number"
                    min={1}
                    defaultValue={p.bodyRetentionDays}
                    className="input w-full"
                  />
                </div>
                <div className="sm:col-span-2">
                  <button type="submit" className="btn-primary">Save changes</button>
                </div>
              </form>

              <form action={revokeApiKey} className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <p className="label">Revoke an API key</p>
                <div className="flex gap-2">
                  <input
                    name="keyId"
                    className="input flex-1 font-mono text-xs"
                    placeholder="key id (shown at creation)"
                  />
                  <button type="submit" className="btn-danger">Revoke</button>
                </div>
              </form>
            </details>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="mb-3 text-base font-semibold">Add project</h2>
        <form action={createProject} className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input name="name" required className="input w-full" placeholder="AMLify production" />
          </div>
          <div>
            <label className="label">Slug</label>
            <input
              name="slug"
              required
              pattern="[a-z0-9-]+"
              className="input w-full"
              placeholder="amlify-prod"
            />
          </div>
          <div>
            <label className="label">Body retention</label>
            <select name="bodyRetention" defaultValue="REDACTED" className="input w-full">
              <option value="NONE">none</option>
              <option value="REDACTED">redacted (default)</option>
              <option value="FULL">full</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Retention days</label>
              <input name="bodyRetentionDays" type="number" min={1} defaultValue={90} className="input w-full" />
            </div>
            <div>
              <label className="label">Hourly cap</label>
              <input name="hourlyCap" type="number" min={1} className="input w-full" placeholder="none" />
            </div>
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className="btn-primary">Add project</button>
          </div>
        </form>
      </section>
    </div>
  );
}
