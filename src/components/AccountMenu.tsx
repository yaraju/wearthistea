"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleUserRound, Package, MapPin, LogOut } from "lucide-react";
import { useAccount } from "@/lib/account-context";

const PILL_CLS =
  "rounded-full border-2 border-ink px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors duration-200 hover:bg-ink hover:text-paper";

/**
 * Replaces the bare "Admin" link every visitor used to see. Signed out:
 * a "Login" pill (into /account, which already renders CustomerSignIn).
 * Signed in: a profile-icon dropdown with Delivery settings/Orders/Sign
 * out. The "Admin" pill only reappears alongside it for an actually
 * signed-in admin — no reason to advertise the admin surface to anyone
 * else. No dropdown primitive exists elsewhere in this codebase to reuse,
 * so this is hand-built (plain useState + click-outside).
 */
export default function AccountMenu() {
  const { loading, signedIn, email, isAdmin, refresh } = useAccount();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function signOut() {
    setOpen(false);
    await fetch("/api/auth/logout", { method: "POST" });
    await refresh();
    router.push("/");
  }

  if (loading) {
    // Reserve the icon's footprint so nothing shifts once auth resolves.
    return <div className="h-9 w-9 rounded-full border-2 border-line" aria-hidden />;
  }

  if (!signedIn) {
    return (
      <Link href="/account" className={PILL_CLS}>
        Login
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-2 border-ink text-ink transition-colors duration-200 hover:bg-ink hover:text-paper"
        >
          <CircleUserRound className="h-5 w-5" aria-hidden />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-2 w-56 rounded-2xl border border-line bg-paper-2 p-1.5 shadow-lg"
          >
            {email && (
              <div className="truncate px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink-soft">
                {email}
              </div>
            )}
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-xl px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-paper"
            >
              <MapPin className="h-4 w-4" aria-hidden /> Delivery settings
            </Link>
            <Link
              href="/account/orders"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-xl px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-paper"
            >
              <Package className="h-4 w-4" aria-hidden /> Orders
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-paper"
            >
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </button>
          </div>
        )}
      </div>

      {isAdmin && (
        <Link href="/admin" className={PILL_CLS}>
          Admin
        </Link>
      )}
    </div>
  );
}
