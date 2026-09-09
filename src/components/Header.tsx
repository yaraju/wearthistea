import Link from "next/link";
import AccountMenu from "@/components/AccountMenu";

/** Thin header for account-area pages — logo + AccountMenu, no marketing
 *  anchors (unlike the homepage's own hand-rolled header). */
export default function Header() {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
      <Link href="/" className="font-display text-2xl font-bold tracking-tight">
        wearthis<span className="text-tea">tea</span>
        <span className="text-pink">.</span>
      </Link>
      <AccountMenu />
    </header>
  );
}
