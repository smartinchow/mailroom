import Link from "next/link";
import { logout } from "@/app/login/actions";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/messages", label: "Messages" },
  { href: "/suppressions", label: "Suppressions" },
  { href: "/settings/carriers", label: "Carriers" },
  { href: "/settings/domains", label: "Domains" },
  { href: "/settings/projects", label: "Projects" },
];

export default function DashLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-base font-bold tracking-tight">
            Mailroom
          </Link>
          <nav className="flex flex-1 flex-wrap items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <form action={logout}>
            <button type="submit" className="btn px-2 py-1 text-xs">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
