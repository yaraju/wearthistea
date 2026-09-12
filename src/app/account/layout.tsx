"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAccount } from "@/lib/account-context";
import CustomerSignIn from "@/components/CustomerSignIn";
import Header from "@/components/Header";

const TABS = [
  { href: "/account", label: "Delivery settings" },
  { href: "/account/orders", label: "Orders" },
  { href: "/account/designs", label: "Your brews" },
];

/**
 * Owns the sign-in gate that used to be duplicated at the top of
 * account/page.tsx — now shared by /account and /account/orders, reading
 * the shared AccountProvider context instead of each page doing its own
 * /api/account/me fetch.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const { loading, signedIn, refresh } = useAccount();
  const pathname = usePathname();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center font-mono text-sm text-ink-soft">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="mx-auto mt-24 max-w-sm p-6">
        <h1 className="mb-4 font-display text-xl font-bold">Sign in</h1>
        <CustomerSignIn onSignedIn={refresh} />
      </div>
    );
  }

  return (
    <div>
      <Header />
      <nav className="mx-auto flex max-w-lg gap-4 px-6 pt-4 font-mono text-xs uppercase tracking-widest">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={pathname === tab.href ? "text-ink" : "text-ink-soft hover:text-ink"}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
