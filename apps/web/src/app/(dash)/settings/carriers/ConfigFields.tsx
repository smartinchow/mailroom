"use client";

import { useId, useState } from "react";
import type { CarrierType } from "@/lib/types";

/**
 * Type-specific credential fields. Used for both create (required) and edit
 * (all optional — blank means "keep existing"; the API never echoes config).
 */
export function ConfigFields({
  type,
  required,
}: {
  type: CarrierType;
  required: boolean;
}) {
  const secureId = useId();
  if (type === "ACS") {
    return (
      <>
        <div className="sm:col-span-2">
          <label className="label">Connection string</label>
          <input
            name="connectionString"
            required={required}
            className="input w-full font-mono text-xs"
            placeholder="endpoint=https://….communication.azure.com/;accesskey=…"
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label">ACS resource id</label>
          <input
            name="resourceId"
            required={required}
            className="input w-full font-mono text-xs"
            placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Communication/communicationServices/…"
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Used to authenticate Event Grid deliveries (topic check).
          </p>
        </div>
      </>
    );
  }
  if (type === "SES") {
    return (
      <>
        <div>
          <label className="label">Region</label>
          <input name="region" required={required} className="input w-full" placeholder="ap-southeast-2" autoComplete="off" />
        </div>
        <div>
          <label className="label">Configuration set</label>
          <input name="configurationSet" required={required} className="input w-full" placeholder="mailroom-events" autoComplete="off" />
        </div>
        <div>
          <label className="label">Access key id</label>
          <input name="accessKeyId" required={required} className="input w-full font-mono text-xs" autoComplete="off" />
        </div>
        <div>
          <label className="label">Secret access key</label>
          <input name="secretAccessKey" type="password" required={required} className="input w-full font-mono text-xs" autoComplete="new-password" />
        </div>
      </>
    );
  }
  return (
    <>
      <div>
        <label className="label">Host</label>
        <input name="host" required={required} className="input w-full" placeholder="smtp.azurecomm.net" autoComplete="off" />
      </div>
      <div>
        <label className="label">Port</label>
        <input name="port" type="number" defaultValue={required ? 587 : undefined} className="input w-full" autoComplete="off" />
      </div>
      <div>
        <label className="label">Username</label>
        <input name="user" required={required} className="input w-full font-mono text-xs" autoComplete="off" />
      </div>
      <div>
        <label className="label">Password</label>
        <input name="pass" type="password" required={required} className="input w-full font-mono text-xs" autoComplete="new-password" />
      </div>
      <div className="flex items-center gap-2">
        <input id={secureId} name="secure" type="checkbox" />
        <label htmlFor={secureId} className="text-sm">
          TLS (secure)
        </label>
      </div>
    </>
  );
}

export function NewCarrierForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  const [type, setType] = useState<CarrierType>("ACS");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="type" value={type} />
      <div>
        <label className="label">Name</label>
        <input name="name" required className="input w-full" placeholder="acs-prod" />
      </div>
      <div>
        <label className="label">Type</label>
        <select
          className="input w-full"
          value={type}
          onChange={(e) => setType(e.target.value as CarrierType)}
        >
          <option value="ACS">ACS (Azure Communication Services)</option>
          <option value="SES">SES (Amazon)</option>
          <option value="SMTP">SMTP</option>
        </select>
      </div>
      <ConfigFields type={type} required />
      <div>
        <label className="label">Rate / second</label>
        <input name="ratePerSecond" type="number" min={1} defaultValue={1} className="input w-full" />
      </div>
      <div>
        <label className="label">Rate / hour</label>
        <input name="ratePerHour" type="number" min={1} defaultValue={100} className="input w-full" />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          New ACS resources start around 100/hour until Azure raises the quota.
        </p>
      </div>
      <div className="sm:col-span-2">
        <button type="submit" className="btn-primary">Add carrier</button>
      </div>
    </form>
  );
}
