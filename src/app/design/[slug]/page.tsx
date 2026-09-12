import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import DesignPageClient from "./DesignPageClient";

export const runtime = "nodejs";

function siteUrl(): string {
  return (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
}

async function getDesign(slug: string) {
  const design =
    (await prisma.design.findUnique({ where: { slug } })) ??
    (await prisma.design.findUnique({ where: { id: slug } }));
  if (!design || design.status !== "generated") return null;
  return design;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const design = await getDesign(slug);
  if (!design) return { title: "Design not found — wearthistea" };

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
  const design = await getDesign(slug);
  if (!design) notFound();

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
    />
  );
}
