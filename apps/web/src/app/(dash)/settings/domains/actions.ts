"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, api, apiErrorCode } from "@/lib/api";
import type { Domain } from "@/lib/types";

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? "").trim();
}

/** Add domain (Settings → Domains). On failure, bounces back with ?error=<code>. */
export async function createDomain(formData: FormData) {
  const projectId = str(formData, "projectId");
  const carrierId = str(formData, "carrierId");
  const notes = str(formData, "notes");

  try {
    await api<Domain>("/domains", {
      method: "POST",
      body: JSON.stringify({
        name: str(formData, "name").toLowerCase(),
        projectId: projectId || null,
        ...(carrierId ? { carrierId } : {}),
        ...(notes ? { notes } : {}),
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      redirect(`/settings/domains?error=${encodeURIComponent(apiErrorCode(err) ?? "unknown")}`);
    }
    throw err;
  }

  revalidatePath("/settings/domains");
  redirect("/settings/domains");
}

/**
 * Update project / fallback carrier / notes (detail page "Edit" section). The primary
 * carrier is only sent when the form includes it (manual domains, no DNS records) —
 * provisioned (SES) domains keep their carrier select hidden since the identity lives on
 * that carrier.
 */
export async function updateDomain(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  const projectId = str(formData, "projectId");
  const carrierId = str(formData, "carrierId");
  const fallbackCarrierId = str(formData, "fallbackCarrierId");
  const notes = str(formData, "notes");

  try {
    await api<Domain>(`/domains/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        projectId: projectId || null,
        ...(carrierId ? { carrierId } : {}),
        fallbackCarrierId: fallbackCarrierId || null,
        notes: notes || null,
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      redirect(
        `/settings/domains/${encodeURIComponent(id)}?error=${encodeURIComponent(apiErrorCode(err) ?? "unknown")}`,
      );
    }
    throw err;
  }

  revalidatePath(`/settings/domains/${id}`);
  revalidatePath("/settings/domains");
}

/** Re-run provider verification for one domain (detail page). */
export async function verifyDomain(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  await api<Domain>(`/domains/${encodeURIComponent(id)}/verify`, { method: "POST" });

  revalidatePath(`/settings/domains/${id}`);
  revalidatePath("/settings/domains");
}

/** Delete a domain (detail page). 409 domain_in_use bounces back with ?error=domain_in_use. */
export async function deleteDomain(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  try {
    await api(`/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof ApiError) {
      redirect(
        `/settings/domains/${encodeURIComponent(id)}?error=${encodeURIComponent(apiErrorCode(err) ?? "unknown")}`,
      );
    }
    throw err;
  }

  revalidatePath("/settings/domains");
  redirect("/settings/domains");
}
