import {
  DNS_RECORD_STATUS_CHIP_CLASSES,
  DOMAIN_STATUS_CHIP_CLASSES,
  STATUS_CHIP_CLASSES,
} from "@/lib/format";
import type { DnsRecordStatus, DomainStatus, MessageStatus } from "@/lib/types";

const FALLBACK_CHIP_CLASS = "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200";

export function StatusChip({ status }: { status: MessageStatus }) {
  const cls = STATUS_CHIP_CLASSES[status] ?? FALLBACK_CHIP_CLASS;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {status}
    </span>
  );
}

/** verified = green, pending/temporary_failure = amber, failed = red. */
export function DomainStatusChip({ status }: { status: DomainStatus }) {
  const cls = DOMAIN_STATUS_CHIP_CLASSES[status] ?? FALLBACK_CHIP_CLASS;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function DnsRecordStatusChip({ status }: { status: DnsRecordStatus }) {
  const cls = DNS_RECORD_STATUS_CHIP_CLASSES[status] ?? FALLBACK_CHIP_CLASS;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
