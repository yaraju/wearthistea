import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { resolveLatestDesignVersion, getDesignVersionChain } from "@/lib/design-versions";
import type { DesignVersionSummary } from "@/lib/types";
import DesignPageClient from "./DesignPageClient";

export const runtime = "nodejs";

function siteUrl(): string {
  return (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Resolves `slug` (or a raw id) to the design to actually DISPLAY, plus its
 * full version-chain lineage. Anonymous/customer viewers are always shown
 * the current-best version — a superseded design is never directly
 * orderable — by rendering the latest version's art in place at the
 * original URL (no redirect: this codebase's admin-detection is entirely
 * client-side, see checkAuth() in admin/page.tsx, so a server-side redirect
 * here would make it impossible for an admin to ever land on the original
 * slug to see the chain). DesignPageClient decides, client-side, whether to
 * show the admin chain banner on top of this same resolved page.
 *
 * `chain` is always computed (cheap: 0 extra queries for the overwhelming
 * common case of a design that was never regenerated) so an admin viewing
 * *any* slug in a chain sees the whole lineage, not just the one they
 * happened to land on.
 */
async function getDesign(slug: string) {
  const requested =
    (await prisma.design.findUnique({ where: { slug } })) ??
    (await prisma.design.findUnique({ where: { id: slug } }));
  if (!requested) return null;

  const latest = await resolveLatestDesignVersion(requested);
  // The terminal version might still be mid-render (or have failed) — fall
  // back to whatever's actually renderable rather than 404ing a perfectly
  // good original just because its brand-new sibling isn't ready yet.
  const display = latest.status === "generated" ? latest : requested;
  if (display.status !== "generated") return null;

  const chainEntries = await getDesignVersionChain(requested);
  const chain: DesignVersionSummary[] = chainEntries.map(({ design: d, isLatest, isRequested }) => ({
    id: d.id,
    slug: d.slug,
    title: d.title,
    validationStatus: d.validationStatus,
    isLatest,
    isRequested,
    productPreviewImagePath: d.productPreviewImagePath ?? "",
    designPreviewImagePath: d.designPreviewImagePath ?? "",
  }));

  return { display, chain };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const result = await getDesign(slug);
  if (!result) return { title: "Design not found — wearthistea" };
  const { display: design } = result;

  const img = design.designPreviewImagePath || design.productPreviewImagePath;
  const title = `${design.title} — wearthistea`;
  const description = `“${design.phrase}” — an AI-brewed tee design. Wear the tea before it cools.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: img ? [`${siteUrl()}${img}`] : undefined,
    },
  };
}

export default async function DesignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getDesign(slug);
  if (!result) notFound();
  const { display: design, chain } = result;

  // Never send the full-res print file to a public caller — only previews.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { designImagePath, productImagePath, designImageData, backDesignImagePath, ...safeDesign } = design;

  return (
    <DesignPageClient
      design={{
        ...safeDesign,
        // These are only ever empty pre-render — status === "generated" (checked
        // above) guarantees both are populated, but the DB column stays nullable.
        productPreviewImagePath: safeDesign.productPreviewImagePath ?? "",
        designPreviewImagePath: safeDesign.designPreviewImagePath ?? "",
      }}
      // Only worth sending down (and having the client check isAdmin for) when
      // there's an actual chain to show — a design that was never regenerated
      // has exactly one entry, itself.
      versionChain={chain.length > 1 ? chain : undefined}
    />
  );
}
