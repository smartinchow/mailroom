import type { MessageStatus } from "./types";

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const STATUS_CHIP_CLASSES: Record<MessageStatus, string> = {
  QUEUED: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200",
  SENDING: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200",
  SENT: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  DELIVERED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  BOUNCED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  SUPPRESSED: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  SPAM: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  COMPLAINED: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
  FAILED: "bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-200",
};

export const ALL_STATUSES: MessageStatus[] = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "BOUNCED",
  "SUPPRESSED",
  "SPAM",
  "COMPLAINED",
  "FAILED",
];
