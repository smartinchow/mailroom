"use server";

import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import type { CreatedKey } from "@/lib/types";

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? "").trim();
}

export async function createProject(formData: FormData) {
  const bodyRetention = str(formData, "bodyRetention");
  const bodyRetentionDays = str(formData, "bodyRetentionDays");
  const hourlyCap = str(formData, "hourlyCap");
  await api("/projects", {
    method: "POST",
    body: JSON.stringify({
      name: str(formData, "name"),
      slug: str(formData, "slug"),
      ...(bodyRetention ? { bodyRetention } : {}),
      ...(bodyRetentionDays ? { bodyRetentionDays: Number(bodyRetentionDays) } : {}),
      ...(hourlyCap ? { hourlyCap: Number(hourlyCap) } : {}),
    }),
  });
  revalidatePath("/settings/projects");
}

export async function updateProject(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;
  const hourlyCap = str(formData, "hourlyCap");
  await api(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: str(formData, "name"),
      bodyRetention: str(formData, "bodyRetention"),
      bodyRetentionDays: Number(str(formData, "bodyRetentionDays") || 90),
      hourlyCap: hourlyCap ? Number(hourlyCap) : null,
    }),
  });
  revalidatePath("/settings/projects");
}

/**
 * Creates an API key and returns the plaintext to the caller for one-time
 * display. The plaintext exists only in this response — it is never stored
 * and can never be shown again.
 */
export async function createApiKey(projectId: string, name: string): Promise<CreatedKey> {
  const created = await api<CreatedKey>(
    `/projects/${encodeURIComponent(projectId)}/keys`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  revalidatePath("/settings/projects");
  return created;
}

export async function revokeApiKey(formData: FormData) {
  const id = str(formData, "keyId");
  if (!id) return;
  await api(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/settings/projects");
}
