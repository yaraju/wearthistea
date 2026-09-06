import type { Metadata } from "next";
import { LegalDoc, Section, List, A, Mail, LEGAL } from "@/components/legal";

export const metadata: Metadata = {
  title: "Cookie Policy — wearthistea",
  description:
    "How wearthistea uses cookies and similar technologies, including Google Analytics.",
};

export default function CookiesPage() {
  return (
    <LegalDoc
      title="Cookie Policy"
      intro={
        <>
          This Cookie Policy explains how {LEGAL.brand} uses cookies and similar
          technologies on our website. It should be read alongside our{" "}
          <A href="/privacy">Privacy Policy</A>.
        </>
      }
    >
      <Section title="1. What are cookies?">
        <p>
          Cookies are small text files placed on your device when you visit a
          website. They are widely used to make sites work, to remember
          preferences, and to understand how a site is used. &ldquo;Similar
          technologies&rdquo; include things like local storage that perform
          comparable functions.
        </p>
      </Section>

      <Section title="2. How we use cookies">
        <p>
          We use <strong>strictly necessary</strong> cookies and storage — the
          kind required for the site to function — plus analytics cookies to
          understand how the site is used:
        </p>
        <List>
          <li>
            <strong>Access / session.</strong> When access protection is
            enabled, your browser stores the credentials or session needed to
            keep you signed in as you move between pages.
          </li>
          <li>
            <strong>Basic functionality and security.</strong> Storage needed to
            load pages correctly and protect the Service.
          </li>
          <li>
            <strong>Analytics.</strong> We use Google Analytics to understand
            how visitors use the site — which pages are viewed, roughly how
            long people spend on them, and general location/device
            information. Google may set cookies on your device for this
            purpose. See{" "}
            <A href="https://policies.google.com/privacy">
              Google&rsquo;s Privacy Policy
            </A>{" "}
            for how Google handles this data.
          </li>
        </List>
      </Section>

      <Section title="3. What we don&rsquo;t use">
        <p>
          We do <strong>not</strong> currently use advertising or marketing
          cookies, and we don&rsquo;t use cross-site tracking. If that
          changes, we will update this policy and, where required, ask for
          your consent first.
        </p>
      </Section>

      <Section title="4. Third-party cookies">
        <p>
          When you complete a purchase, you may be taken to a connected
          storefront or to our fulfillment partner,{" "}
          <A href="https://printify.com">Printify</A>. Those services may set
          their own cookies on their own pages, governed by their cookie and
          privacy policies — not this one.
        </p>
      </Section>

      <Section title="5. Managing cookies">
        <p>
          You can control or delete cookies through your browser settings, and
          set your browser to block them. Note that blocking strictly necessary
          cookies may prevent parts of the site — such as staying signed in —
          from working properly.
        </p>
      </Section>

      <Section title="6. Changes to this policy">
        <p>
          We may update this Cookie Policy from time to time. We&rsquo;ll revise
          the &ldquo;Last updated&rdquo; date above when we do.
        </p>
      </Section>

      <Section title="7. Contact">
        <p>
          Questions about our use of cookies? Email us at <Mail />.
        </p>
      </Section>
    </LegalDoc>
  );
}
