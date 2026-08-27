import type { Carrier as CarrierRow } from "@prisma/client";
import { decrypt } from "../crypto.js";
import { createAcsCarrier } from "./acs.js";
import { createSesCarrier } from "./ses.js";
import { createSmtpCarrier } from "./smtp.js";
import type { Carrier, CarrierConfig } from "./types.js";

const cache = new Map<string, { carrier: Carrier; configEnc: string }>();

/** Decrypt a carrier row's config and build (or reuse) its adapter. */
export function carrierFor(row: CarrierRow): Carrier {
  const cached = cache.get(row.id);
  if (cached && cached.configEnc === row.configEnc) return cached.carrier;

  const config = JSON.parse(decrypt(row.configEnc)) as CarrierConfig;
  let carrier: Carrier;
  switch (config.type) {
    case "acs":
      carrier = createAcsCarrier(config);
      break;
    case "ses":
      carrier = createSesCarrier(config);
      break;
    case "smtp":
      carrier = createSmtpCarrier(config);
      break;
    default:
      throw new Error(`unknown carrier config type on carrier ${row.id}`);
  }
  cache.set(row.id, { carrier, configEnc: row.configEnc });
  return carrier;
}

export function invalidateCarrierCache(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}
