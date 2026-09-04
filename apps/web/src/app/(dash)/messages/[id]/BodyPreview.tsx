"use client";

import { useMemo, useState } from "react";
import { buildBodySrcdoc } from "@/lib/srcdoc";

/**
 * SECURITY-CRITICAL (design §10.4). Stored bodies carry live magic-link /
 * invite tokens and untrusted third-party HTML. Rendering rules:
 *   - <iframe sandbox=""> — empty sandbox: no scripts, no same-origin, no
 *     forms, no popups. Never add sandbox tokens here.
 *   - srcdoc document injects CSP default-src 'none'; remote images blocked
 *     (img-src 'none') until the operator clicks "Load remote images", which
 *     re-renders with img-src https: — so opening a log entry can never phone
 *     home or fire a tracking pixel on its own.
 */
export function BodyPreview({
  bodyHtml,
  bodyText,
  bodyPurgedAt,
  redactedLinkCount,
}: {
  bodyHtml: string | null;
  bodyText: string | null;
  bodyPurgedAt: string | null;
  redactedLinkCount: number;
}) {
  const [tab, setTab] = useState<"html" | "text">(bodyHtml ? "html" : "text");
  const [loadRemoteImages, setLoadRemoteImages] = useState(false);

  const srcdoc = useMemo(
    () => (bodyHtml ? buildBodySrcdoc(bodyHtml, loadRemoteImages) : null),
    [bodyHtml, loadRemoteImages],
  );

  if (bodyPurgedAt) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Body purged on {new Date(bodyPurgedAt).toLocaleDateString()} per this
        project&apos;s retention policy. Metadata and events are retained.
      </div>
    );
  }

  if (!bodyHtml && !bodyText) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No body stored (project retention policy is <code>none</code>).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {redactedLinkCount > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {redactedLinkCount} link{redactedLinkCount === 1 ? "" : "s"} redacted — tokens
          were stripped at write time, so this preview is not verbatim.
        </p>
      )}

      <div className="flex items-center gap-2">
        {bodyHtml && (
          <button
            type="button"
            onClick={() => setTab("html")}
            className={tab === "html" ? "btn-primary px-2.5 py-1 text-xs" : "btn px-2.5 py-1 text-xs"}
          >
            HTML
          </button>
        )}
        {bodyText && (
          <button
            type="button"
            onClick={() => setTab("text")}
            className={tab === "text" ? "btn-primary px-2.5 py-1 text-xs" : "btn px-2.5 py-1 text-xs"}
          >
            Text
          </button>
        )}
        {tab === "html" && bodyHtml && !loadRemoteImages && (
          <button
            type="button"
            onClick={() => setLoadRemoteImages(true)}
            className="btn ml-auto px-2.5 py-1 text-xs"
            title="Remote images are blocked by default so opening a message cannot fire tracking pixels."
          >
            Load remote images
          </button>
        )}
        {tab === "html" && loadRemoteImages && (
          <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
            Remote images loaded (https only)
          </span>
        )}
      </div>

      {tab === "html" && srcdoc ? (
        <iframe
          key={loadRemoteImages ? "imgs-on" : "imgs-off"}
          sandbox=""
          srcDoc={srcdoc}
          referrerPolicy="no-referrer"
          title="Message body preview (sandboxed)"
          className="h-[560px] w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-800"
        />
      ) : (
        <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          {bodyText}
        </pre>
      )}
    </div>
  );
}
