"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import AdminLogin from "@/components/AdminLogin";
import { VALIDATION_STATUSES } from "@/lib/validation-status";

// Admin control panel for a bulk judge run (issue #19) — same underlying
// pipeline as scripts/judge-designs.ts (issue #18), started/polled here
// instead of shelled into. Same auth-gate shape as /admin/page.tsx: a
// client-side Firebase-session check just so an unsigned-in visitor sees a
// sign-in form instead of a broken page — every /api/admin/* route enforces
// admin access server-side regardless.
export default function JudgeRunsPage() {
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
  return <JudgeRunsConsole />;
}

interface RunSummary {
  id: string;
  mode: "auto" | "manual";
  statusFilter: string;
  limit: number;
  status: "running" | "completed" | "failed";
  total: number;
  processed: number;
  outcomeCounts: Record<string, number>;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdByEmail: string | null;
}

interface RubricRow {
  name: string;
  passed: number;
  total: number;
}

interface FlaggedRow {
  designId: string;
  title: string;
  outcome: string;
  detail: string;
  verdict: unknown;
  siblingId?: string;
  sibling: { id: string; slug: string | null; status: string } | null;
}

function JudgeRunsConsole() {
  const [statusFilter, setStatusFilter] = useState<string>("unjudged");
  const [limit, setLimit] = useState(10);
  const [mode, setMode] = useState<"auto" | "manual">("manual");
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

  const [recent, setRecent] = useState<RunSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [rubrics, setRubrics] = useState<RubricRow[]>([]);
  const [flagged, setFlagged] = useState<FlaggedRow[]>([]);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/judge-runs?limit=20", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setRecent(data.runs ?? []);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecent();
  }, [loadRecent]);

  const loadRun = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/admin/judge-runs/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setRun(data.run);
      setRubrics(data.rubrics ?? []);
      setFlagged(data.flagged ?? []);
    } catch {
      // transient — the next poll tick will try again
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const openRun = useCallback(
    (id: string) => {
      stopPolling();
      setActiveId(id);
      loadRun(id);
      pollTimer.current = setInterval(async () => {
        await loadRun(id);
      }, 2500);
    },
    [loadRun, stopPolling]
  );

  // Stop polling once the active run reaches a terminal status.
  useEffect(() => {
    if (run && run.status !== "running") {
      stopPolling();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadRecent();
    }
  }, [run, stopPolling, loadRecent]);

  async function startRun() {
    setStarting(true);
    setStartErr(null);
    try {
      const res = await fetch("/api/admin/judge-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statusFilter, limit, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not start the run.");
      loadRecent();
      if (data.run?.id) openRun(data.run.id);
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : "Could not start the run.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b-2 border-ink bg-ink text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
          <div>
            <Link href="/" className="font-display text-2xl font-bold">
              wearthis<span className="text-tea-bright">tea</span>
              <span className="text-pink">.</span>
            </Link>
            <h1 className="kicker mt-1 text-paper/60">bulk judge runs</h1>
          </div>
          <Link
            href="/admin"
            className="inline-flex cursor-pointer items-center gap-2 rounded-full border-2 border-paper px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors duration-200 hover:bg-paper hover:text-ink"
          >
            ← Queue
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* ── Start a run ── */}
        <div className="sticker mb-8 rounded-2xl bg-paper-2 p-5">
          <h2 className="kicker mb-3 text-ink-soft">start a run</h2>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 font-mono text-xs">
              status filter
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                disabled={starting}
                className="rounded-lg border-2 border-line bg-paper px-2 py-1.5"
              >
                {VALIDATION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 font-mono text-xs">
              limit
              <input
                type="number"
                min={1}
                max={200}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 1)}
                disabled={starting}
                className="w-24 rounded-lg border-2 border-line bg-paper px-2 py-1.5"
              />
            </label>
            <fieldset className="flex flex-col gap-1 font-mono text-xs" disabled={starting}>
              mode — frozen once started
              <div className="flex gap-3 rounded-lg border-2 border-line bg-paper px-3 py-1.5">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "manual"}
                    onChange={() => setMode("manual")}
                  />
                  manual review
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "auto"}
                    onChange={() => setMode("auto")}
                  />
                  auto-regenerate
                </label>
              </div>
            </fieldset>
            <button
              onClick={startRun}
              disabled={starting}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl border-2 border-ink bg-tea-bright px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:opacity-50"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Start run"}
            </button>
          </div>
          {mode === "auto" && (
            <p className="mt-3 flex items-start gap-1.5 font-mono text-[11px] text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Auto-regenerate writes real Design rows: passing designs are marked &quot;validated&quot;, eligible
              failures get a fresh sibling created and rendered automatically, and the original is marked
              &quot;superseded&quot;.
            </p>
          )}
          {startErr && <p className="mt-3 text-xs text-pink-ink">{startErr}</p>}
        </div>

        {/* ── Recent runs ── */}
        <div className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="kicker text-ink-soft">recent runs</h2>
            <button
              onClick={loadRecent}
              className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-ink-soft hover:text-ink"
            >
              <RefreshCw className="h-3 w-3" aria-hidden /> refresh
            </button>
          </div>
          {recent.length === 0 ? (
            <p className="font-mono text-xs text-ink-soft">No runs yet.</p>
          ) : (
            <div className="grid gap-2">
              {recent.map((r) => (
                <button
                  key={r.id}
                  onClick={() => openRun(r.id)}
                  className={`flex items-center justify-between rounded-lg border-2 px-3 py-2 text-left font-mono text-xs transition-colors duration-200 ${
                    activeId === r.id ? "border-ink bg-paper-2" : "border-line bg-paper hover:border-ink"
                  }`}
                >
                  <span>
                    <span className="font-bold uppercase">{r.mode}</span> · {r.statusFilter} · limit {r.limit} ·{" "}
                    {new Date(r.startedAt).toLocaleString()}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-ink-soft">
                      {r.processed}/{r.total}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 uppercase ${
                        r.status === "running"
                          ? "border-tea text-tea"
                          : r.status === "failed"
                            ? "border-pink text-pink-ink"
                            : "border-line text-ink-soft"
                      }`}
                    >
                      {r.status}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Active run detail ── */}
        {run && (
          <RunDetail
            run={run}
            rubrics={rubrics}
            flagged={flagged}
            onFlaggedRegenerated={() => activeId && loadRun(activeId)}
          />
        )}
      </div>
    </main>
  );
}

function RunDetail({
  run,
  rubrics,
  flagged,
  onFlaggedRegenerated,
}: {
  run: RunSummary;
  rubrics: RubricRow[];
  flagged: FlaggedRow[];
  onFlaggedRegenerated: () => void;
}) {
  const pct = run.total > 0 ? Math.round((run.processed / run.total) * 100) : 100;

  return (
    <div className="sticker rounded-2xl bg-paper-2 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-xl font-bold">
          Run · {run.mode} · {run.statusFilter}
        </h2>
        <span
          className={`rounded-full border-2 px-3 py-1 font-mono text-[11px] uppercase ${
            run.status === "running"
              ? "border-tea text-tea"
              : run.status === "failed"
                ? "border-pink text-pink-ink"
                : "border-ink text-ink"
          }`}
        >
          {run.status}
        </span>
      </div>

      {run.error && (
        <p className="mb-3 flex items-start gap-1.5 rounded-lg bg-amber-100 p-2 font-mono text-[11px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {run.error}
        </p>
      )}

      <div className="mb-1 h-3 w-full overflow-hidden rounded-full border-2 border-ink bg-paper">
        <div className="h-full bg-tea-bright transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <p className="mb-4 font-mono text-xs text-ink-soft">
        {run.processed}/{run.total} processed ({pct}%)
      </p>

      {rubrics.length > 0 && (
        <div className="mb-4">
          <p className="kicker mb-2 text-ink-soft">rubric pass rates</p>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {rubrics.map((r) => (
              <div key={r.name} className="rounded-lg border border-line bg-paper p-2 font-mono text-[11px]">
                <span className="font-bold">{r.name}</span>:{" "}
                {r.total === 0 ? "no designs checked" : `${r.passed}/${r.total} (${Math.round((r.passed / r.total) * 100)}%)`}
              </div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(run.outcomeCounts).length > 0 && (
        <div className="mb-4">
          <p className="kicker mb-2 text-ink-soft">outcome counts</p>
          <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
            {Object.entries(run.outcomeCounts).map(([k, v]) => (
              <span key={k} className="rounded-full border border-line bg-paper px-2 py-1">
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {flagged.length > 0 && (
        <div>
          <p className="kicker mb-2 text-ink-soft">flagged designs ({flagged.length})</p>
          <div className="grid gap-2">
            {flagged.map((f) => (
              <FlaggedRowCard key={f.designId} row={f} runId={run.id} mode={run.mode} onRegenerated={onFlaggedRegenerated} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FlaggedRowCard({
  row,
  runId,
  mode,
  onRegenerated,
}: {
  row: FlaggedRow;
  runId: string;
  mode: "auto" | "manual";
  onRegenerated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function regenerate() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/judge-runs/${runId}/flagged/${row.designId}/regenerate`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not regenerate.");
      onRegenerated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not regenerate.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-bold">{row.title}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
            {row.outcome} — {row.detail}
          </p>
        </div>
        {row.sibling ? (
          row.sibling.slug ? (
            <a
              href={`/design/${row.sibling.slug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-tea hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> sibling ({row.sibling.status})
            </a>
          ) : (
            // Known gap (issue #29): a sibling created by the regenerate
            // path has no slug/embeddings yet, so there's no working public
            // share URL for it — shown plainly rather than a dead link.
            <span className="shrink-0 font-mono text-[11px] text-ink-soft">
              sibling created ({row.sibling.status}) — no share link yet
            </span>
          )
        ) : mode === "manual" ? (
          <button
            onClick={regenerate}
            disabled={busy}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-2 border-ink bg-paper px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-ink transition-colors duration-200 hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Regenerate"}
          </button>
        ) : null}
      </div>
      {err && <p className="mt-2 text-xs text-pink-ink">{err}</p>}
    </div>
  );
}
