import "./globals.css";
import Link from "next/link";
import SyncBanner from "@/components/SyncBanner";

export const metadata = { title: "Budget v2" };

const navLinks = [
  { href: "/", label: "Dashboard" },
  { href: "/review", label: "Review" },
  { href: "/duplicates", label: "Duplicates" },
  { href: "/planning", label: "Planning" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="flex items-center gap-1 px-6 py-3 border-b border-neutral-800 text-sm">
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="px-3 py-1.5 rounded-md text-neutral-300 hover:text-white hover:bg-neutral-800/60"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/link"
            className="ml-auto px-3 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800/60"
          >
            + Connect bank
          </Link>
        </nav>
        <SyncBanner />
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
