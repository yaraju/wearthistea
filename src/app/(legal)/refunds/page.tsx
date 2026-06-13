import type { Metadata } from "next";
import { LegalDoc, Section, List, A, Mail, LEGAL } from "@/components/legal";

export const metadata: Metadata = {
  title: "Refund & Returns Policy — wearthistea",
  description:
    "How returns, refunds, replacements, and cancellations work for wearthistea's print-on-demand products.",
};

export default function RefundsPage() {
  return (
    <LegalDoc
      title="Refund & Returns Policy"
      intro={
        <>
          Every {LEGAL.brand} item is printed to order, just for you. That keeps
          designs fresh and waste low — and it shapes the policy below. We stand
          firmly behind the quality of what we ship.
        </>
      }
    >
      <Section title="1. Made-to-order items">
        <p>
          Because each product is custom printed when you order it, we generally
          cannot accept returns or offer refunds for buyer&rsquo;s remorse or for
          ordering the wrong size. Please review the product details and size
          guide before purchasing. The exceptions below always apply.
        </p>
      </Section>

      <Section title="2. Damaged, defective, or misprinted items">
        <p>
          If your item arrives damaged, defective, or misprinted, we&rsquo;ll
          make it right. Contact us at <Mail /> within{" "}
          <strong>[30]</strong> days of delivery with:
        </p>
        <List>
          <li>your order number;</li>
          <li>a description of the problem;</li>
          <li>clear photos of the item and any packaging.</li>
        </List>
        <p>
          We&rsquo;ll arrange a free replacement or a refund at no cost to you.
        </p>
      </Section>

      <Section title="3. Wrong item received">
        <p>
          If you receive the wrong product, contact us at <Mail /> with your
          order number and a photo, and we&rsquo;ll send the correct item or
          issue a refund.
        </p>
      </Section>

      <Section title="4. Sizing and exchanges">
        <p>
          Since items are made to order, we cannot offer free size exchanges.
          Please use the size guide before ordering. At our discretion we may
          help arrange a new order, for which reprint and shipping costs may
          apply.
        </p>
      </Section>

      <Section title="5. Lost or delayed in transit">
        <p>
          If your order doesn&rsquo;t arrive in a reasonable time, contact us at{" "}
          <Mail /> and we&rsquo;ll work with the carrier and our fulfillment
          partner,{" "}
          <A href="https://printify.com">Printify</A>, to locate it or arrange a
          replacement.
        </p>
      </Section>

      <Section title="6. Changes and cancellations">
        <p>
          We can usually only change or cancel an order before it enters
          production, which often begins shortly after you order. If you need a
          change, email <Mail /> as soon as possible and we&rsquo;ll do our best.
        </p>
      </Section>

      <Section title="7. How refunds are issued">
        <p>
          Approved refunds are issued to your original payment method. Timing
          depends on the storefront and payment provider where you purchased, and
          typically takes a few business days to appear after processing.
        </p>
      </Section>

      <Section title="8. Where you purchased">
        <p>
          {LEGAL.brand} products may be sold through connected third-party
          storefronts. If you bought through one of those stores, its own return
          policy may also apply. Either way, contact us at <Mail /> and
          we&rsquo;ll help you sort it out.
        </p>
      </Section>

      <Section title="9. Contact">
        <p>
          Need help with an order? Email us at <Mail /> with your order number
          and we&rsquo;ll get back to you.
        </p>
      </Section>
    </LegalDoc>
  );
}
