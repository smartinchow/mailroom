"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, api, apiErrorCode } from "@/lib/api";
import type { Domain } from "@/lib/types";

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? "").trim();
}

/**
 * One sender address per line, as typed: `support@tintinpos.com` or
 * `Support <support@tintinpos.com>`. Sent through verbatim — reducing an
 * address to the local part the provider wants is the carrier's job, not the
 * dashboard's.
 */
function lines(fd: FormData, name: string): string[] {
  return String(fd.get(name) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
 * Update project / fallback carrier / notes / sender addresses (detail page "Edit"
 * section). The primary carrier is only sent when the form includes it (manual domains,
 * no DNS records) — provisioned (SES) domains keep their carrier select hidden since the
 * identity lives on that carrier.
 */
export async function updateDomain(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  const projectId = str(formData, "projectId");
  const carrierId = str(formData, "carrierId");
  const fallbackCarrierId = str(formData, "fallbackCarrierId");
  const notes = str(formData, "notes");
  // Only sent when the form actually rendered the field — an absent textarea
  // must read as "unchanged", never as "the operator cleared the list".
  const senderUsernames = formData.has("senderUsernames") ? lines(formData, "senderUsernames") : null;

  try {
    await api<Domain>(`/domains/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        projectId: projectId || null,
        ...(carrierId ? { carrierId } : {}),
        fallbackCarrierId: fallbackCarrierId || null,
        notes: notes || null,
        ...(senderUsernames ? { senderUsernames } : {}),
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
