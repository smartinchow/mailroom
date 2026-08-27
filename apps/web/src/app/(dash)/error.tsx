"use client";

export default function DashError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card border-red-200 dark:border-red-900">
      <h2 className="mb-2 text-lg font-semibold text-red-700 dark:text-red-400">
        Something went wrong
      </h2>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        {error.message || "The admin API request failed. Is the API up and API_URL configured?"}
      </p>
      <button className="btn" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
