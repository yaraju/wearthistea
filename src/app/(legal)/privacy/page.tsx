import type { Metadata } from "next";
import { LegalDoc, Section, List, A, Mail, LEGAL } from "@/components/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — wearthistea",
  description:
    "How wearthistea collects, uses, and protects your information — including the prompts you submit and the AI and fulfillment partners we rely on.",
};

export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy Policy"
      intro={
        <>
          This Privacy Policy explains what information {LEGAL.brand} (&ldquo;we,&rdquo;
          &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects when you use our
          website and AI design generator (the &ldquo;Service&rdquo;), how we
          use it, and the choices you have.
        </>
      }
    >
      <Section title="1. Information we collect">
        <p>We keep data collection deliberately minimal.</p>
        <List>
          <li>
            <strong>Prompts you submit.</strong> The &ldquo;tea&rdquo; you type
            to generate designs. We store these together with the designs they
            produce so the Service can function.
          </li>
          <li>
            <strong>Technical and log data.</strong> Standard information your
            browser sends — such as IP address, browser type, and timestamps —
            used to operate and secure the Service.
          </li>
        </List>
        <p>
          We do <strong>not</strong> require an account, and we do not ask for
          your name, shipping address, or payment details on this website — any
          purchase happens on a connected storefront (see Section 3). We do not
          sell your personal information.
        </p>
      </Section>

      <Section title="2. How we use information">
        <p>We use the information above to:</p>
        <List>
          <li>generate t-shirt design concepts and artwork from your prompt;</li>
          <li>operate, maintain, secure, and improve the Service;</li>
          <li>detect and prevent abuse, fraud, and technical problems;</li>
          <li>comply with legal obligations.</li>
        </List>
      </Section>

      <Section title="3. AI processing and third parties">
        <p>
          To provide the Service, your information is processed by trusted third
          parties under their own privacy policies:
        </p>
        <List>
          <li>
            <strong>Google (Gemini API).</strong> The prompts you submit are
            sent to Google to generate the design text and images. See{" "}
            <A href="https://policies.google.com/privacy">
              Google&rsquo;s Privacy Policy
            </A>
            .
          </li>
          <li>
            <strong>Printify.</strong> Products are produced and shipped by{" "}
            <A href="https://printify.com/privacy-policy/">Printify</A> and its
            print providers, which process order and shipping data at the time
            of purchase.
          </li>
          <li>
            <strong>Infrastructure.</strong> The Service is hosted on Google
            Cloud and Firebase, and uses a Neon (PostgreSQL) database to store
            batches, designs, and prompts.
          </li>
          <li>
            <strong>Google Analytics.</strong> We use Google Analytics to
            understand how visitors use the Service — pages viewed, time
            spent, and general location/device information. See{" "}
            <A href="https://policies.google.com/privacy">
              Google&rsquo;s Privacy Policy
            </A>
            .
          </li>
        </List>
      </Section>

      <Section title="4. Cookies">
        <p>
          We use strictly necessary cookies (for example, to keep you signed
          in when access protection is enabled) and analytics cookies via
          Google Analytics. We do not use advertising or cross-site tracking
          cookies. For details, see our <A href="/cookies">Cookie Policy</A>.
        </p>
      </Section>

      <Section title="5. Data retention">
        <p>
          We retain prompts and generated designs for as long as needed to
          operate the Service and for legitimate business or legal purposes. You
          can ask us to delete data associated with you at any time (see Section
          6).
        </p>
      </Section>

      <Section title="6. Your rights">
        <p>
          Depending on where you live, you may have rights to access, correct,
          delete, or restrict the processing of your personal information, and
          to object to certain uses (for example under the GDPR, UK GDPR, or
          CCPA/CPRA). To exercise any of these rights, email <Mail /> and we
          will respond as required by applicable law.
        </p>
      </Section>

      <Section title="7. International data transfers">
        <p>
          We and our service providers may process information in countries
          other than your own, including the United States. Where required, we
          rely on appropriate safeguards for such transfers.
        </p>
      </Section>

      <Section title="8. Children&rsquo;s privacy">
        <p>
          The Service is not directed to children under 13 (or the minimum age
          in your jurisdiction), and we do not knowingly collect their personal
          information. If you believe a child has provided us information, please
          contact us so we can delete it.
        </p>
      </Section>

      <Section title="9. Security">
        <p>
          We use reasonable technical and organizational measures to protect
          information. However, no method of transmission or storage is
          completely secure, and we cannot guarantee absolute security.
        </p>
      </Section>

      <Section title="10. Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. We will revise the
          &ldquo;Last updated&rdquo; date above when we do, and material changes
          will be reflected here.
        </p>
      </Section>

      <Section title="11. Contact">
        <p>
          Questions or requests about your privacy? Email us at <Mail />.
        </p>
      </Section>
    </LegalDoc>
  );
}
