import { STATUS_CHIP_CLASSES } from "@/lib/format";
import type { MessageStatus } from "@/lib/types";

export function StatusChip({ status }: { status: MessageStatus }) {
  const cls =
    STATUS_CHIP_CLASSES[status] ??
    "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {status}
    </span>
  );
}
