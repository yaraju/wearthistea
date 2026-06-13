import type { Metadata } from "next";
import { LegalDoc, Section, List, A, Mail, LEGAL } from "@/components/legal";

export const metadata: Metadata = {
  title: "Terms of Service — wearthistea",
  description:
    "The terms that govern your use of the wearthistea website, AI design generator, and print-on-demand products.",
};

export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms of Service"
      intro={
        <>
          Welcome to {LEGAL.brand}. These Terms of Service (the
          &ldquo;Terms&rdquo;) govern your access to and use of the{" "}
          {LEGAL.brand} website, our AI design generator, and any products we
          offer (together, the &ldquo;Service&rdquo;). By using the Service you
          agree to these Terms. If you do not agree, please do not use the
          Service.
        </>
      }
    >
      <Section title="1. Who we are">
        <p>
          The Service is operated by {LEGAL.brand} (&ldquo;we,&rdquo;
          &ldquo;us,&rdquo; or &ldquo;our&rdquo;). You can reach us any time at{" "}
          <Mail />.
        </p>
      </Section>

      <Section title="2. Eligibility">
        <p>
          You must be at least the age of majority in your jurisdiction (or have
          the consent of a parent or legal guardian) to use the Service. By
          using it, you confirm that you meet this requirement and that the
          information you provide is accurate.
        </p>
      </Section>

      <Section title="3. What the Service does">
        <p>
          You type a short prompt — a piece of internet drama, a feud, a vibe
          (&ldquo;the tea&rdquo;). Our Service uses artificial intelligence to
          generate original t-shirt design concepts and artwork from that
          prompt. You can select designs you like; selected designs may be
          curated, produced on demand, and offered for sale through our
          print-on-demand partner and connected storefronts.
        </p>
      </Section>

      <Section title="4. Your prompts and submissions">
        <p>
          You are solely responsible for the prompts and any other content you
          submit. By submitting a prompt, you grant us a worldwide,
          royalty-free, non-exclusive license to use, store, and process it to
          operate, secure, and improve the Service.
        </p>
        <p>You agree not to submit content that:</p>
        <List>
          <li>is unlawful, infringing, defamatory, harassing, or hateful;</li>
          <li>
            misappropriates a real person&rsquo;s name, likeness, or identity,
            or that targets a private individual;
          </li>
          <li>
            reproduces third-party trademarks, logos, copyrighted lyrics, or
            other protected works;
          </li>
          <li>
            is sexually explicit, depicts minors inappropriately, or promotes
            violence or illegal activity.
          </li>
        </List>
        <p>
          We may refuse, remove, or decline to produce any prompt or design at
          our discretion.
        </p>
      </Section>

      <Section title="5. AI-generated designs">
        <p>
          Designs are produced by AI and are intended to be original and
          evocative <em>by association</em> — stylized references rather than
          exact likenesses or reproductions of protected works. AI output is
          provided &ldquo;as is.&rdquo; We do not guarantee that any design is
          unique or entirely free of similarity to existing works, and we may
          decline to produce or sell any design.
        </p>
      </Section>

      <Section title="6. Intellectual property">
        <p>
          The {LEGAL.brand} name, logo, site design, and underlying software are
          owned by us and protected by intellectual-property laws. We retain all
          rights in the design artwork generated through the Service. When you
          purchase a physical product, you own that product; this does not
          transfer ownership of the underlying artwork or any trademark rights.
        </p>
      </Section>

      <Section title="7. Orders, pricing, and fulfillment">
        <p>
          Products are made to order and fulfilled by our print-on-demand
          partner, <A href="https://printify.com">Printify</A>, and its print
          providers. Prices, shipping options, and applicable taxes are shown at
          the point of sale on the storefront where the product is offered. We
          may correct pricing or description errors and cancel affected orders.
          Returns and refunds are handled under our{" "}
          <A href="/refunds">Refund &amp; Returns Policy</A>.
        </p>
      </Section>

      <Section title="8. Third-party services">
        <p>
          The Service relies on third parties, including Google (the Gemini AI
          API), Printify (fulfillment), and the storefront and payment
          processors where products are sold. Your use of those services is
          subject to their own terms and privacy policies, and we are not
          responsible for them.
        </p>
      </Section>

      <Section title="9. Acceptable use">
        <p>You agree not to:</p>
        <List>
          <li>
            abuse, overload, or attempt to disrupt the Service or its automated
            generation features;
          </li>
          <li>
            scrape, reverse engineer, or copy the Service except as permitted by
            law;
          </li>
          <li>
            use the Service to create or sell content that violates Section 4.
          </li>
        </List>
      </Section>

      <Section title="10. Disclaimers">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as
          available,&rdquo; without warranties of any kind, whether express or
          implied, including merchantability, fitness for a particular purpose,
          and non-infringement. We do not warrant that the Service will be
          uninterrupted, error-free, or secure.
        </p>
      </Section>

      <Section title="11. Limitation of liability">
        <p>
          To the maximum extent permitted by law, {LEGAL.brand} and its
          operators will not be liable for any indirect, incidental, special,
          consequential, or punitive damages, or for any loss of profits or
          data, arising from your use of the Service. Our total liability for
          any claim relating to the Service will not exceed the amount you paid
          us for the product or service giving rise to the claim.
        </p>
      </Section>

      <Section title="12. Indemnification">
        <p>
          You agree to indemnify and hold harmless {LEGAL.brand} and its
          operators from any claims, damages, or expenses (including reasonable
          legal fees) arising from the prompts or content you submit or your
          violation of these Terms.
        </p>
      </Section>

      <Section title="13. Suspension and termination">
        <p>
          We may suspend or terminate your access to the Service at any time if
          you violate these Terms or to protect the Service or other users.
        </p>
      </Section>

      <Section title="14. Changes to these Terms">
        <p>
          We may update these Terms from time to time. When we do, we will
          revise the &ldquo;Last updated&rdquo; date above. Your continued use
          of the Service after changes take effect constitutes acceptance of the
          updated Terms.
        </p>
      </Section>

      <Section title="15. Governing law">
        <p>
          These Terms are governed by the laws of {LEGAL.governingLaw}, without
          regard to conflict-of-laws principles. Any disputes will be resolved
          in the courts located there, unless applicable law requires otherwise.
        </p>
      </Section>

      <Section title="16. Contact">
        <p>
          Questions about these Terms? Email us at <Mail />.
        </p>
      </Section>
    </LegalDoc>
  );
}
