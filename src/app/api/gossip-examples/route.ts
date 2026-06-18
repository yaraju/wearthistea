import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateGossipExamples } from "@/lib/gemini";

export const runtime = "nodejs";

const CACHE_KEY = "gossip-examples";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 1 day

export async function GET() {
  try {
    const now = new Date();
    
    // 1. Check cache
    const cached = await prisma.cache.findUnique({
      where: { key: CACHE_KEY },
    });

    if (cached && cached.expiresAt > now) {
      return NextResponse.json({ examples: JSON.parse(cached.value) });
    }

    // 2. Cache miss or expired — fetch from Gemini
    const examples = await generateGossipExamples();

    // 3. Update cache
    await prisma.cache.upsert({
      where: { key: CACHE_KEY },
      update: {
        value: JSON.stringify(examples),
        expiresAt: new Date(now.getTime() + CACHE_TTL_SECONDS * 1000),
      },
      create: {
        key: CACHE_KEY,
        value: JSON.stringify(examples),
        expiresAt: new Date(now.getTime() + CACHE_TTL_SECONDS * 1000),
      },
    });

    return NextResponse.json({ examples });
  } catch (err) {
    console.error("Failed to fetch gossip examples:", err);
    // Fallback in case of error
    return NextResponse.json({
      examples: [
        "the group chat finally imploded",
        "celebrity feud of the week",
        "my situationship has a podcast now",
        "office drama: someone replied-all",
        "mercury is in microwave",
      ],
    });
  }
}
