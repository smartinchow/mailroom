"use server";

import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import type { CarrierType } from "@/lib/types";

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? "").trim();
}

/** Build the type-specific config object from form fields. Returns null if every field is blank. */
function configFrom(type: CarrierType, fd: FormData): Record<string, unknown> | null {
  if (type === "ACS") {
    const connectionString = str(fd, "connectionString");
    const resourceId = str(fd, "resourceId");
    if (!connectionString && !resourceId) return null;
    return { connectionString, resourceId };
  }
  if (type === "SES") {
    const region = str(fd, "region");
    const accessKeyId = str(fd, "accessKeyId");
    const secretAccessKey = str(fd, "secretAccessKey");
    const configurationSet = str(fd, "configurationSet");
    if (!region && !accessKeyId && !secretAccessKey && !configurationSet) return null;
    return { region, accessKeyId, secretAccessKey, configurationSet };
  }
  const host = str(fd, "host");
  const port = str(fd, "port");
  const user = str(fd, "user");
  const pass = str(fd, "pass");
  if (!host && !port && !user && !pass) return null;
  return {
    host,
    port: port ? Number(port) : 587,
    secure: fd.get("secure") === "on",
    user,
    pass,
  };
}

export async function createCarrier(formData: FormData) {
  const type = str(formData, "type") as CarrierType;
  const config = configFrom(type, formData) ?? {};
  await api("/carriers", {
    method: "POST",
    body: JSON.stringify({
      name: str(formData, "name"),
      type,
      config,
      ratePerSecond: Number(str(formData, "ratePerSecond") || 1),
      ratePerHour: Number(str(formData, "ratePerHour") || 100),
    }),
  });
  revalidatePath("/settings/carriers");
  revalidatePath("/");
}

export async function updateCarrier(formData: FormData) {
  const id = str(formData, "id");
  const type = str(formData, "type") as CarrierType;
  if (!id) return;

  const config = configFrom(type, formData);
  await api(`/carriers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: str(formData, "name"),
      ratePerSecond: Number(str(formData, "ratePerSecond") || 1),
      ratePerHour: Number(str(formData, "ratePerHour") || 100),
      // config omitted = credentials unchanged (the API never returns them)
      ...(config ? { config } : {}),
    }),
  });
  revalidatePath("/settings/carriers");
  revalidatePath("/");
}

export async function toggleCarrier(formData: FormData) {
  const id = str(formData, "id");
  const enabled = formData.get("enabled") === "true";
  if (!id) return;
  await api(`/carriers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
  revalidatePath("/settings/carriers");
  revalidatePath("/");
}

/** Make this carrier the platform default for new domains (server clears the flag elsewhere). */
export async function makeDefaultCarrier(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;
  await api(`/carriers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ isDefault: true }),
  });
  revalidatePath("/settings/carriers");
  revalidatePath("/settings/domains");
}
