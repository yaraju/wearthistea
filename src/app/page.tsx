import Link from "next/link";
import {
  MessageSquareQuote,
  Sparkles,
  Shirt,
  Zap,
  ShieldCheck,
  Palette,
  BadgeCheck,
} from "lucide-react";
import KeywordStudio from "@/components/KeywordStudio";
import { LEGAL, LEGAL_LINKS } from "@/components/legal";
import AccountMenu from "@/components/AccountMenu";
import AdminFooterLink from "@/components/AdminFooterLink";

const TICKER = [
  "SPILL THE TEA",
  "WEAR THE TEA",
  "GOSSIP YOU CAN WEAR",
  "AI-DESIGNED IN SECONDS",
  "BREWED FRESH DAILY",
  "DRAMA → DROP",
];

export default function Home() {
  return (
    <main className="overflow-x-hidden">
      <a href="#content" className="skip-link">
        Skip to the tea
      </a>

      {/* Top ticker (decorative) */}
      <div
        aria-hidden="true"
        className="marquee overflow-hidden border-y-2 border-ink bg-ink py-2 text-paper"
      >
        <div className="marquee-track gap-8 font-mono text-xs uppercase tracking-[0.2em]">
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i} className="flex items-center gap-8">
              {t} <span className="text-pink">☕</span>
            </span>
          ))}
        </div>
      </div>

      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Link href="/" className="font-display text-2xl font-bold tracking-tight">
          wearthis<span className="text-tea">tea</span>
          <span className="text-pink">.</span>
        </Link>
        <nav className="flex items-center gap-5 font-mono text-xs uppercase tracking-wider">
          <a href="#how" className="hidden text-ink-soft hover:text-ink sm:block">
            How it works
          </a>
          <a href="#why" className="hidden text-ink-soft hover:text-ink sm:block">
            Why it slaps
          </a>
          <AccountMenu />
        </nav>
      </header>

      {/* Hero */}
      <section
        id="content"
        tabIndex={-1}
        className="relative mx-auto max-w-6xl px-5 pb-12 pt-8 outline-none sm:pt-14"
      >
        {/* floating stickers */}
        <div
          aria-hidden
          className="float-y sticker sticker-tea absolute -left-2 top-24 hidden rotate-[-8deg] rounded-xl bg-tea-bright px-3 py-2 font-mono text-[11px] font-bold uppercase text-ink lg:block"
          style={{ "--rot": "-8deg" } as React.CSSProperties}
        >
          no chill ☕
        </div>
        <div
          aria-hidden
          className="float-y sticker absolute right-0 top-40 hidden rotate-[7deg] rounded-xl bg-highlight px-3 py-2 font-mono text-[11px] font-bold uppercase text-ink lg:block"
          style={
            { "--rot": "7deg", animationDelay: "1.2s" } as React.CSSProperties
          }
        >
          100% original
        </div>

        <div className="mx-auto max-w-3xl text-center">
          <p className="kicker mb-5 inline-block rounded-full border border-line bg-paper-2 px-3 py-1.5 text-ink-soft">
            AI tea ⇢ wearable drama
          </p>
          <h1 className="headline text-[clamp(2.8rem,9vw,6.5rem)]">
            Spill the tea.
            <br />
            <span className="text-pink">Wear</span> the tea.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-ink-soft">
            Type any piece of internet drama, a feud, or an unhinged group-chat
            moment. Our AI brews{" "}
            <span className="marker font-semibold text-ink">5 original</span>{" "}
            t-shirt designs in seconds. Pick your favorite — we print &amp; ship
            it.
          </p>
        </div>

        {/* The studio */}
        <div className="mx-auto mt-10 max-w-3xl">
          <KeywordStudio />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t-2 border-ink bg-paper-2">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
          <div className="mb-12 flex flex-col items-start gap-3">
            <span className="kicker text-pink-ink">the brew</span>
            <h2 className="headline text-4xl sm:text-5xl">
              Three sips to a t-shirt.
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                icon: MessageSquareQuote,
                step: "01",
                title: "Spill it",
                body: "Drop the tea into the box — a celebrity feud, office drama, or whatever your group chat won't shut up about.",
              },
              {
                icon: Sparkles,
                step: "02",
                title: "We brew",
                body: "AI writes punchy, original lines and illustrates each one — editorial line-art, never a photo rip-off. Five takes, instantly.",
              },
              {
                icon: Shirt,
                step: "03",
                title: "You wear",
                body: "Pick the one that hits. We push it to print on premium Bella+Canvas blanks and ship the drop to your door.",
              },
            ].map(({ icon: Icon, step, title, body }) => (
              <div
                key={step}
                className="sticker flex flex-col rounded-2xl bg-paper p-6"
              >
                <div className="flex items-center justify-between">
                  <span className="grid h-12 w-12 place-items-center rounded-xl border-2 border-ink bg-pink text-paper">
                    <Icon className="h-6 w-6" aria-hidden />
                  </span>
                  <span className="font-display text-4xl font-bold text-line">
                    {step}
                  </span>
                </div>
                <h3 className="mt-5 font-display text-2xl font-bold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why it slaps */}
      <section id="why" className="border-t-2 border-ink">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
          <div className="mb-12 max-w-2xl">
            <span className="kicker text-tea">why it slaps</span>
            <h2 className="headline mt-3 text-4xl sm:text-5xl">
              Timely. Original. <span className="text-pink">Yours.</span>
            </h2>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Zap,
                title: "Internet-speed",
                body: "Tea cools fast. Go from headline to wearable in under a minute, while it's still funny.",
              },
              {
                icon: Palette,
                title: "Actually original",
                body: "Every design is generated fresh. No stolen art, no recycled memes — a look that's only yours.",
              },
              {
                icon: ShieldCheck,
                title: "Plays it safe",
                body: "Stylized line-art by association, not photo likenesses or copyrighted lines. Funny, not sued.",
              },
              {
                icon: BadgeCheck,
                title: "Premium blanks",
                body: "Printed on super-soft Bella+Canvas 3001 — the tee people keep wearing after the joke lands.",
              },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex flex-col gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl border-2 border-ink bg-highlight">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="font-display text-xl font-bold">{title}</h3>
                <p className="text-sm leading-relaxed text-ink-soft">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="border-t-2 border-ink bg-ink text-paper">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
          <span className="kicker text-highlight">overheard</span>
          <h2 className="headline mt-3 max-w-3xl text-4xl text-paper sm:text-5xl">
            “I wore the drama before the apology video dropped.”
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              {
                quote:
                  "Typed in my roommate situation, got a tee so accurate it's basically evidence.",
                who: "the group chat, allegedly",
              },
              {
                quote:
                  "Finally, fast fashion that's actually about something. The tea was piping.",
                who: "a chronically online icon",
              },
              {
                quote:
                  "Wore it to brunch. Three people asked. One gasped. Worth it.",
                who: "certified messy bestie",
              },
            ].map((t) => (
              <figure
                key={t.who}
                className="rounded-2xl border border-paper/20 bg-paper/5 p-6"
              >
                <blockquote className="font-display text-lg leading-snug">
                  “{t.quote}”
                </blockquote>
                <figcaption className="mt-4 font-mono text-xs uppercase tracking-wider text-highlight">
                  — {t.who}
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="mt-8 font-mono text-[11px] uppercase tracking-wider text-paper/50">
            * dramatized testimonials. the tea, however, is real.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t-2 border-ink">
        <div className="mx-auto max-w-3xl px-5 py-20 text-center sm:py-28">
          <h2 className="headline text-[clamp(2.4rem,7vw,4.5rem)]">
            Got tea? <span className="text-tea">Brew a tee.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-ink-soft">
            The kettle&apos;s already hot. Scroll back up and spill — your first
            five designs are seconds away.
          </p>
          <a
            href="#studio"
            className="mt-8 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-pink px-8 py-4 font-mono text-sm font-bold uppercase tracking-wider text-paper transition-colors duration-200 hover:bg-pink-ink"
          >
            <Sparkles className="h-4 w-4" aria-hidden /> Spill the tea
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-2 border-ink bg-paper-2">
        <div className="mx-auto max-w-6xl px-5 py-8">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="font-display text-xl font-bold">
              wearthis<span className="text-tea">tea</span>
              <span className="text-pink">.</span>
            </p>
            <p className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">
              gossip you can wear · brewed with AI · printed on demand
            </p>
            <AdminFooterLink />
          </div>
          <nav className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-line pt-6 font-mono text-[11px] uppercase tracking-wider text-ink-soft">
            <span>© {LEGAL.year} {LEGAL.brand}</span>
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-ink">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </main>
  );
}
