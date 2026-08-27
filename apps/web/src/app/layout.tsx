import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mailroom",
  description: "Self-hosted transactional email dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
