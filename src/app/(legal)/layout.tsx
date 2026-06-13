import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LEGAL, LEGAL_LINKS } from "@/components/legal";

// Shared chrome for all legal/policy pages (/terms, /privacy, /refunds, /cookies).
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b-2 border-ink">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
          <Link
            href="/"
            className="font-display text-2xl font-bold tracking-tight"
          >
            wearthis<span className="text-tea">tea</span>
            <span className="text-pink">.</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to the tea
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12 sm:py-16">
        {children}
      </main>

      <footer className="border-t-2 border-ink bg-paper-2">
        <div className="mx-auto max-w-3xl px-5 py-8">
          <nav className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-ink-soft">
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-ink">
                {l.label}
              </Link>
            ))}
          </nav>
          <p className="mt-4 font-mono text-[11px] text-ink-soft">
            © {LEGAL.year} {LEGAL.brand}. Questions about these policies? Email{" "}
            <a
              href={`mailto:${LEGAL.email}`}
              className="text-tea underline underline-offset-2 hover:text-pink-ink"
            >
              {LEGAL.email}
            </a>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}
