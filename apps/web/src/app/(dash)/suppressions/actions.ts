"use server";

import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

export async function addSuppression(formData: FormData) {
  const address = String(formData.get("address") ?? "").trim().toLowerCase();
  const scope = String(formData.get("scope") ?? "").trim();
  if (!address) return;
  await api("/suppressions", {
    method: "POST",
    body: JSON.stringify({
      address,
      ...(scope && scope !== "GLOBAL" ? { scope } : {}),
      reason: "MANUAL",
    }),
  });
  revalidatePath("/suppressions");
}

export async function removeSuppression(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await api(`/suppressions/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/suppressions");
}
