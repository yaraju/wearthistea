import Link from "next/link";

// ── Single source of truth for the legal pages ───────────────────────────────
// NOTE: These documents are plain-language templates tailored to how
// wearthistea works. They are NOT legal advice — have them reviewed by a
// qualified professional before relying on them.
export const LEGAL = {
  brand: "wearthistea",
  email: "wearthistea@gmail.com",
  governingLaw: "the United States",
  updated: "September 6, 2026",
  year: "2026",
};

export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refunds", label: "Refund & Returns" },
  { href: "/cookies", label: "Cookie Policy" },
  { href: "/contact", label: "Contact" },
];

/** Page wrapper: kicker + title + last-updated + optional intro. */
export function LegalDoc({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <article>
      <p className="kicker text-ink-soft">{LEGAL.brand} · legal</p>
      <h1 className="headline mt-2 text-4xl sm:text-5xl">{title}</h1>
      <p className="mt-3 font-mono text-xs text-ink-soft">
        Last updated: {LEGAL.updated}
      </p>
      {intro && (
        <p className="mt-6 text-lg leading-relaxed text-ink-soft">{intro}</p>
      )}
      <div>{children}</div>
    </article>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9">
      <h2 className="font-display text-2xl font-bold leading-tight">{title}</h2>
      <div className="mt-3 space-y-3 leading-relaxed text-ink-soft">
        {children}
      </div>
    </section>
  );
}

/** Bulleted list with brand-consistent spacing. */
export function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-ink-soft">
      {children}
    </ul>
  );
}

/** Inline link that styles internal (Next) and external/mailto links alike. */
export function A({ href, children }: { href: string; children: React.ReactNode }) {
  const cls =
    "font-medium text-tea underline underline-offset-2 hover:text-pink-ink";
  const isHttp = href.startsWith("http");
  if (isHttp || href.startsWith("mailto:")) {
    return (
      <a
        href={href}
        className={cls}
        target={isHttp ? "_blank" : undefined}
        rel={isHttp ? "noreferrer" : undefined}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** mailto: link to the contact address. */
export function Mail() {
  return <A href={`mailto:${LEGAL.email}`}>{LEGAL.email}</A>;
}
