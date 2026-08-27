import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const secret = process.env.WEB_SESSION_SECRET;
  if (token && secret && (await verifySessionToken(secret, token))) {
    redirect("/");
  }

  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold">Mailroom</h1>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Operator sign-in
        </p>
        {error === "1" && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            Wrong password.
          </p>
        )}
        {error === "config" && (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            ADMIN_PASSWORD or WEB_SESSION_SECRET is not configured on the server.
          </p>
        )}
        <form action={login} className="space-y-3">
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              className="input w-full"
            />
          </div>
          <button type="submit" className="btn-primary w-full justify-center">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
