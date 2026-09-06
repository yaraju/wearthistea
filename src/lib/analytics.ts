"use client";

import { sendGAEvent } from "@next/third-parties/google";

/** No-ops when NEXT_PUBLIC_GA_MEASUREMENT_ID isn't set (e.g. local dev). */
export function track(event: string, params: Record<string, unknown> = {}) {
  if (!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID) return;
  sendGAEvent("event", event, params);
}
