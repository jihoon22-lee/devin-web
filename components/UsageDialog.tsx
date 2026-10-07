"use client";

import { Fragment, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { api } from "@/lib/client/api";
import type { UsageReport } from "@/lib/usage";
import Modal from "./Modal";
import { displayTitle, tildePath } from "@/lib/client/display";
import { useUiPrefs } from "@/lib/client/uiPrefs";
import { budgetState } from "@/lib/client/budget";

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

const fmtCost = (n: number) => (n > 0 && n < 0.01 ? "<0.01" : n.toFixed(2));

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-(--color-border) bg-(--color-panel2)/60 px-2.5 py-2" title={title}>
      <div className="text-tiny uppercase tracking-wider text-(--color-faint) truncate">{label}</div>
      <div className="mono text-sm mt-0.5 truncate">{value}</div>
    </div>
  );
}

/** Per-session token/cost rollup + a 30-day output-token strip — data from
 *  /api/usage (the CLI's sessions.db metrics). */
export default function UsageDialog({ onClose }: { onClose: () => void }) {
  const [r, setR] = useState<UsageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [series, setSeries] = useState<{ at: number; inputTokens: number; outputTokens: number }[] | null>(null);
  const toggle = (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setSeries(null);
    api<{ series: { at: number; inputTokens: number; outputTokens: number }[] }>(`/api/usage/${encodeURIComponent(id)}`)
      .then((d) => setSeries(d.series))
      .catch(() => setSeries([]));
  };
  const peak = series ? Math.max(1, ...series.map((p) => p.outputTokens)) : 1;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api<UsageReport>("/api/usage")
      .then((d) => !cancelled && setR(d))
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, []);

  const { budget } = useUiPrefs();
  const today = r ? budgetState(r.daily, budget?.dailyOutputTokens) : null;
  const daily = (r?.daily ?? []).slice(-14);
  const maxOut = Math.max(1, ...daily.map((d) => d.outputTokens));

  return (
    <Modal onClose={onClose} label="Usage" align="sheet"
      panelClassName="w-full md:max-w-lg max-h-[88dvh] md:max-h-[85vh] flex flex-col rounded-t-2xl md:rounded-xl pb-[env(safe-area-inset-bottom)] border border-(--color-border) bg-(--color-panel) shadow-xl"
    >
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border) shrink-0">
          <span className="text-sm font-medium">Usage</span>
          <button onClick={onClose} className="p-1 rounded text-(--color-dim) hover:text-white" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4 min-h-0">
          {!r && !err && <Loader2 size={16} className="animate-spin text-(--color-dim) mx-auto my-8" />}
          {err && <div className="text-(--color-red) text-sm">{err}</div>}
          {r && (
            <>
              {!r.progress.complete && (
                <div className="text-2xs text-(--color-dim)">
                  Indexing usage… {Math.floor((r.progress.indexedRow / Math.max(1, r.progress.maxRow)) * 100)}% —
                  totals are partial until it finishes
                </div>
              )}
              <div className="flex gap-2">
                <Stat label="input" value={fmt(r.totals.inputTokens)} title={`${r.totals.inputTokens.toLocaleString()} input tokens`} />
                <Stat label="output" value={fmt(r.totals.outputTokens)} title={`${r.totals.outputTokens.toLocaleString()} output tokens`} />
                <Stat label="cache read" value={fmt(r.totals.cacheReadTokens)} title={`${r.totals.cacheReadTokens.toLocaleString()} cache-read tokens`} />
                <Stat label="ACU" value={fmtCost(r.totals.costAcu)} title={`${r.totals.costAcu} total ACU${r.totals.costCredit ? ` · ${r.totals.costCredit} credits` : ""}`} />
              </div>

              {today && (
                <div>
                  <div className="flex justify-between text-tiny uppercase tracking-wider text-(--color-faint) mb-1">
                    <span>Today vs budget</span>
                    <span className={today.over ? "text-(--color-danger)" : today.ratio >= 0.8 ? "text-(--color-warning)" : ""}>
                      {fmt(today.used)} / {fmt(today.budget)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-(--color-panel2) overflow-hidden">
                    <div
                      className={`h-full ${today.over ? "bg-(--color-danger)" : today.ratio >= 0.8 ? "bg-(--color-warning)" : "bg-(--color-accent)"}`}
                      style={{ width: `${today.ratio * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {daily.length > 0 && (
                <div>
                  <div className="text-tiny uppercase tracking-wider text-(--color-faint) mb-1.5">
                    Output tokens / day
                  </div>
                  <div className="flex items-end gap-[3px] h-14">
                    {daily.map((d) => (
                      <div
                        key={d.day}
                        className="flex-1 rounded-sm bg-(--color-accent)/50 hover:bg-(--color-accent) transition-colors min-w-0"
                        style={{ height: `${Math.max(6, (d.outputTokens / maxOut) * 100)}%` }}
                        title={`${d.day}: ${d.outputTokens.toLocaleString()} out · ${d.inputTokens.toLocaleString()} in`}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="text-tiny uppercase tracking-wider text-(--color-faint) mb-1.5">
                  Per session ({r.totals.sessions})
                </div>
                <div className="border border-(--color-border) rounded-lg overflow-hidden">
                  {r.sessions.map((s) => (
                    <Fragment key={s.sessionId}>
                      <button
                        type="button"
                        onClick={() => toggle(s.sessionId)}
                        aria-expanded={openId === s.sessionId}
                        className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-b border-(--color-border)/60 last:border-0 text-xs hover:bg-(--color-panel2)"
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block truncate" title={tildePath(s.cwd)}>
                            {displayTitle(s.title, s.sessionId)}
                          </span>
                          {!!s.responses && (
                            <span className="text-tiny text-(--color-faint)">{s.responses} responses</span>
                          )}
                        </span>
                        <span className="mono text-tiny text-(--color-dim) shrink-0" title="input tokens">
                          {fmt(s.inputTokens)}↓
                        </span>
                        <span className="mono text-tiny text-(--color-dim) shrink-0" title="output tokens">
                          {fmt(s.outputTokens)}↑
                        </span>
                        {s.costAcu > 0 && (
                          <span className="mono text-tiny text-(--color-faint) shrink-0" title="ACU cost">
                            {fmtCost(s.costAcu)}
                          </span>
                        )}
                      </button>
                      {openId === s.sessionId && (
                        <div className="px-2.5 py-2 border-b border-(--color-border)/60">
                          {!series ? (
                            <Loader2 size={12} className="animate-spin text-(--color-dim)" />
                          ) : series.length ? (
                            <>
                              <div className="flex items-end gap-px h-10">
                                {series.map((p, i) => (
                                  <div
                                    key={i}
                                    className="flex-1 min-w-0 rounded-sm bg-(--color-accent)/50 hover:bg-(--color-accent)"
                                    style={{ height: `${Math.max(4, (p.outputTokens / peak) * 100)}%` }}
                                    title={`${new Date(p.at * 1000).toLocaleString()} · ${p.outputTokens.toLocaleString()} out · ${p.inputTokens.toLocaleString()} in`}
                                  />
                                ))}
                              </div>
                              <div className="text-tiny text-(--color-faint) mt-1">
                                {series.length} responses · {new Date(series[0].at * 1000).toLocaleDateString()} –{" "}
                                {new Date(series[series.length - 1].at * 1000).toLocaleDateString()}
                              </div>
                            </>
                          ) : (
                            <div className="text-tiny text-(--color-faint)">no responses with metrics</div>
                          )}
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {!r.sessions.length && (
                    <div className="text-(--color-faint) text-xs text-center py-4">No usage recorded</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
    </Modal>
  );
}
