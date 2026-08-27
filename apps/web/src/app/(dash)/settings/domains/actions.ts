"use server";

import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? "").trim();
}

export async function createDomain(formData: FormData) {
  const projectId = str(formData, "projectId");
  const fallbackCarrierId = str(formData, "fallbackCarrierId");
  const notes = str(formData, "notes");
  await api("/domains", {
    method: "POST",
    body: JSON.stringify({
      name: str(formData, "name").toLowerCase(),
      carrierId: str(formData, "carrierId"),
      ...(projectId ? { projectId } : {}),
      ...(fallbackCarrierId ? { fallbackCarrierId } : {}),
      ...(notes ? { notes } : {}),
    }),
  });
  revalidatePath("/settings/domains");
}

export async function updateDomain(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;
  const projectId = str(formData, "projectId");
  const fallbackCarrierId = str(formData, "fallbackCarrierId");
  await api(`/domains/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      carrierId: str(formData, "carrierId"),
      projectId: projectId || null,
      fallbackCarrierId: fallbackCarrierId || null,
      notes: str(formData, "notes") || null,
    }),
  });
  revalidatePath("/settings/domains");
}

export async function deleteDomain(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;
  await api(`/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/settings/domains");
}
