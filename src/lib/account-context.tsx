"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface AccountState {
  loading: boolean;
  signedIn: boolean;
  email: string | null;
  authProvider: string | null;
  isAdmin: boolean;
}

interface AccountContextValue extends AccountState {
  refresh: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

const INITIAL_STATE: AccountState = {
  loading: true,
  signedIn: false,
  email: null,
  authProvider: null,
  isAdmin: false,
};

/**
 * One shared `/api/account/me` fetch for the whole app, instead of every
 * consumer (header profile menu, homepage's admin footer link, /account
 * layout) independently re-fetching it. Deliberately scoped to just these
 * new consumers — PickDesignModal.tsx and the pre-existing /account
 * page/layout auth check keep their own independent fetches, left
 * untouched as lower-risk out of scope for this change.
 */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AccountState>(INITIAL_STATE);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/account/me", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setState({
        loading: false,
        signedIn: Boolean(data.signedIn),
        email: data.email ?? null,
        authProvider: data.authProvider ?? null,
        isAdmin: Boolean(data.isAdmin),
      });
    } catch {
      setState({ loading: false, signedIn: false, email: null, authProvider: null, isAdmin: false });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  return (
    <AccountContext.Provider value={{ ...state, refresh }}>{children}</AccountContext.Provider>
  );
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount() must be used within an AccountProvider.");
  return ctx;
}
