"use client";

import Link from "next/link";
import { useAccount } from "@/lib/account-context";

/**
 * The footer's duplicate "Admin queue →" link, split out into its own tiny
 * client component so the rest of page.tsx (a server component) doesn't
 * need to become one just to gate this single link on isAdmin.
 */
export default function AdminFooterLink() {
  const { isAdmin } = useAccount();
  if (!isAdmin) return null;

  return (
    <Link
      href="/admin"
      className="font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink"
    >
      Admin queue →
    </Link>
  );
}
