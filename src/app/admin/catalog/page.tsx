"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Search } from "lucide-react";
import { printroveProduct } from "@/config/settings";
import AdminLogin from "@/components/AdminLogin";
import AdminReviewModal from "@/components/AdminReviewModal";

interface CatalogDesignProduct {
  id: string;
  category: string;
  color: string;
  approvalStatus: "unreviewed" | "approved" | "rejected";
  status: string;
}

interface CatalogDesign {
  id: string;
  slug: string | null;
  title: string;
  phrase: string;
  blurb: string | null;
  visualConcept: string;
  designPrompt: string;
  productPrompt: string;
  batchId: string;
  keyword: string;
  status: string;
  errorMessage: string | null;
  category: string;
  variantColor: string | null;
  style: string;
  createdAt: string;
  createdByUserId: string | null;
  createdByEmail: string | null;
  designImagePath: string;
  productImagePath: string;
  designPreviewImagePath: string;
  productPreviewImagePath: string;
  backDesignPreviewImagePath: string | null;
  designProducts: CatalogDesignProduct[];
  distance?: number;
  matchedField?: string;
}

// Same UX-only client gate as /admin — real enforcement is server-side, see
// requireAdmin() in every /api/admin/* route this page calls.
export default function AdminCatalogPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setIsAdmin(Boolean(data.isAdmin));
    } catch {
      setIsAdmin(false);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkAuth();
  }, [checkAuth]);

  if (!authChecked) {
    return (
      <div className="grid min-h-screen place-items-center font-mono text-sm text-ink-soft">loading…</div>
    );
  }
  if (!isAdmin) return <AdminLogin onSignedIn={checkAuth} />;
  return <Catalog />;
}

function Catalog() {
  const [designs, setDesigns] = useState<CatalogDesign[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"text" | "semantic">("text");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CatalogDesign | null>(null);

  const search = useCallback(async (opts: { cursor?: string | null; append?: boolean }) => {
    (opts.append ? setLoadingMore : setLoading)(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) {
        params.set("q", query.trim());
        params.set("mode", mode);
      } else if (opts.cursor) {
        params.set("cursor", opts.cursor);
      }
      const res = await fetch(`/api/admin/designs/catalog?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load the catalog.");
      setDesigns((prev) => (opts.append ? [...prev, ...data.designs] : data.designs));
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [query, mode]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    search({});
  }, [search]);

  function reviewItemsFor(d: CatalogDesign) {
    return d.designProducts.map((dp) => ({
      id: dp.id,
      category: dp.category,
      label: printroveProduct(dp.category).categoryLabel,
      approvalStatus: dp.approvalStatus,
    }));
  }

  return (
    <div className="min-h-screen bg-gray-100 text-black">
      <header className="border-b border-gray-300 bg-white px-5 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h1 className="font-display text-lg font-bold">Design Catalog</h1>
            <Link href="/admin" className="font-mono text-xs uppercase tracking-wide text-gray-500 hover:text-black">
              ← Review queue
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search({});
          }}
          className="mb-6 flex flex-wrap gap-2"
        >
          <div className="relative flex-1 min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by prompt, title, or phrase…"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-black focus:outline-none"
            />
          </div>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "text" | "semantic")}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="text">Literal match</option>
            <option value="semantic">Semantic match</option>
          </select>
          <button
            type="submit"
            className="rounded-lg bg-black px-4 py-2 text-xs font-bold uppercase tracking-wide text-white"
          >
            Search
          </button>
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                search({});
              }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-600"
            >
              Clear
            </button>
          )}
        </form>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {loading ? (
          <div className="grid place-items-center py-20 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : designs.length === 0 ? (
          <p className="py-20 text-center text-sm text-gray-500">No designs found.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {designs.map((d) => {
                const img = d.designPreviewImagePath || d.productPreviewImagePath;
                return (
                  <button
                    key={d.id}
                    onClick={() => setOpen(d)}
                    className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white text-left transition-shadow hover:shadow-md"
                  >
                    <div className="flex aspect-square items-center justify-center bg-gray-50 p-3">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt={d.title} className="max-h-full max-w-full object-contain" />
                      ) : (
                        <span className="text-xs text-gray-400">{d.status}</span>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="truncate text-xs font-bold">{d.title}</p>
                      <p className="truncate text-[11px] text-gray-500">&quot;{d.keyword}&quot;</p>
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-gray-400">
                        {d.status}
                        {typeof d.distance === "number" && ` · ${(1 - d.distance).toFixed(2)} match`}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            {nextCursor && !query && (
              <div className="mt-6 flex justify-center">
                <button
                  onClick={() => search({ cursor: nextCursor, append: true })}
                  disabled={loadingMore}
                  className="rounded-lg border border-gray-300 px-6 py-2 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
                >
                  {loadingMore ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {open && (
        <AdminReviewModal
          mode="catalog"
          design={{
            id: open.id,
            title: open.title,
            phrase: open.phrase,
            designImagePath: open.designImagePath,
            productImagePath: open.productImagePath,
            designPreviewImagePath: open.designPreviewImagePath,
            productPreviewImagePath: open.productPreviewImagePath,
            backDesignPreviewImagePath: open.backDesignPreviewImagePath,
            variantColor: open.variantColor,
            keyword: open.keyword,
            createdAt: open.createdAt,
            createdByEmail: open.createdByEmail,
            status: open.status,
            visualConcept: open.visualConcept,
            designPrompt: open.designPrompt,
            productPrompt: open.productPrompt,
          }}
          items={reviewItemsFor(open)}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            search({});
          }}
        />
      )}
    </div>
  );
}
