import type { Metadata } from "next";
import { Mail as MailIcon } from "lucide-react";
import { Section, A, LEGAL } from "@/components/legal";

export const metadata: Metadata = {
  title: "Contact us — wearthistea",
  description:
    "Get in touch with the wearthistea team — order help, privacy requests, press, or just to say hello.",
};

export default function ContactPage() {
  return (
    <article>
      <p className="kicker text-ink-soft">{LEGAL.brand} · contact</p>
      <h1 className="headline mt-2 text-4xl sm:text-5xl">Contact us</h1>
      <p className="mt-6 text-lg leading-relaxed text-ink-soft">
        Questions, order help, a press request, or just want to say hello?
        We&rsquo;d love to hear from you — a real human reads every message.
      </p>

      {/* Primary contact: email */}
      <div className="sticker sticker-pink mt-8 rounded-2xl bg-paper-2 p-6 sm:p-8">
        <p className="kicker text-ink-soft">email us</p>
        <a
          href={`mailto:${LEGAL.email}`}
          className="mt-2 inline-flex items-center gap-2.5 font-display text-2xl font-bold text-ink hover:text-pink-ink sm:text-3xl"
        >
          <MailIcon className="h-6 w-6 shrink-0 text-pink" aria-hidden />
          {LEGAL.email}
        </a>
        <p className="mt-3 text-sm text-ink-soft">
          We typically reply within 1&ndash;2 business days.
        </p>
      </div>

      <Section title="Help with an order">
        <p>
          Include your <strong>order number</strong> and, for a quality issue, a
          quick photo. See our <A href="/refunds">Refund &amp; Returns Policy</A>{" "}
          for how replacements and refunds work.
        </p>
      </Section>

      <Section title="Privacy requests">
        <p>
          To access or delete data associated with you, email us and mention
          &ldquo;privacy request.&rdquo; The details are in our{" "}
          <A href="/privacy">Privacy Policy</A>.
        </p>
      </Section>

      <Section title="Everything else">
        <p>
          Partnerships, press, feedback, or a bug you spotted — send it over and
          we&rsquo;ll point it to the right place.
        </p>
      </Section>
    </article>
  );
}
