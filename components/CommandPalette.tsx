"use client";

import { useEffect, useRef, useState } from "react";
import { displayTitle, tildePath } from "@/lib/client/display";
import { FolderOpen, MessageSquare, Plus, Search } from "lucide-react";
import { api } from "@/lib/client/api";
import { isImeComposing } from "@/lib/client/keys";
import Modal from "./Modal";
import type { SessionInfo } from "./AppShell";

interface SearchResult {
  sessionId: string;
  title: string | null;
  cwd: string;
  snippets: string[];
  match?: { nodeId: number; anchor?: string };
}

interface Row {
  key: string;
  kind: "session" | "hit" | "action";
  label: string;
  sub?: string;
  session?: SessionInfo;
  match?: SearchResult["match"];
  action?: () => void;
}

export default function CommandPalette({
  sessions,
  onSelect,
  onNew,
  onClose,
  onModelPicker,
}: {
  sessions: SessionInfo[];
  onSelect: (s: SessionInfo, match?: SearchResult["match"]) => void;
  onNew: () => void;
  onClose: () => void;
  /** only provided while a session is open — gates the "Change model…" row */
  onModelPicker?: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  /** results tagged with the query that produced them */
  const [hits, setHits] = useState<{ q: string; results: SearchResult[] }>({ q: "", results: [] });
  const [fCwd, setFCwd] = useState("");
  const [fDays, setFDays] = useState(0); // 0 = all time
  const [fTools, setFTools] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const projects = [...new Set(sessions.map((s) => s.cwd))].sort();
  const filters = { cwd: fCwd, days: fDays, tools: fTools };

  // message search (debounced) once the query is long enough. A response is
  // only used while its query is still current, so a slow answer for an
  // older query can never replace newer results.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      const p = new URLSearchParams({ q: term });
      if (filters.cwd) p.set("cwd", filters.cwd);
      if (filters.days) {
        const now = Math.floor(Date.now() / 1000);
        p.set("from", String(now - filters.days * 86400));
        p.set("to", String(now));
      }
      if (!filters.tools) p.set("tools", "0");
      api<{ results: SearchResult[] }>(`/api/search?${p}`)
        .then((r) => {
          if (!cancelled) setHits({ q: term, results: r.results });
        })
        .catch(() => {
          if (!cancelled) setHits({ q: term, results: [] });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, fCwd, fDays, fTools]);

  const shownHits = q.trim().length >= 2 && hits.q === q.trim() ? hits.results : [];

  const lq = q.toLowerCase();
  const filtered = sessions
    .filter(
      (s) =>
        !lq ||
        (s.title ?? "").toLowerCase().includes(lq) ||
        s.cwd.toLowerCase().includes(lq) ||
        s.sessionId.toLowerCase().includes(lq),
    )
    .slice(0, 8);

  const rows: Row[] = [
    ...filtered.map((s) => ({
      key: `s-${s.sessionId}`,
      kind: "session" as const,
      label: displayTitle(s.title, s.sessionId),
      sub: (s.archived ? "archived · " : "") + tildePath(s.cwd),
      session: s,
    })),
    ...shownHits.map((h) => ({
      key: `h-${h.sessionId}`,
      kind: "hit" as const,
      label: displayTitle(h.title, h.sessionId),
      sub: h.snippets[0] ?? tildePath(h.cwd),
      session: sessions.find((s) => s.sessionId === h.sessionId) ?? {
        sessionId: h.sessionId,
        cwd: h.cwd,
        title: h.title,
      },
      match: h.match,
    })),
    { key: "new", kind: "action", label: "New session…", action: onNew },
    ...(onModelPicker
      ? [{ key: "model", kind: "action" as const, label: "Change model…", action: onModelPicker }]
      : []),
  ];

  const firstHitIdx = rows.findIndex((r) => r.kind === "hit");
  const firstActionIdx = rows.findIndex((r) => r.kind === "action");

  // selection resets to the top when the query or result count changes
  const resetSig = JSON.stringify([q, shownHits.length]);
  const [prevSig, setPrevSig] = useState(resetSig);
  if (prevSig !== resetSig) {
    setPrevSig(resetSig);
    setIdx(0);
  }

  const run = (r: Row) => {
    onClose();
    if (r.action) r.action();
    else if (r.session) onSelect(r.session, r.match);
  };

  return (
    <Modal
      onClose={onClose}
      label="Session picker and search"
      align="top"
      panelClassName="w-[92vw] max-w-lg bg-(--color-panel) border border-(--color-border2) rounded-2xl shadow-2xl overflow-hidden dw-pop"
    >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-(--color-border)">
          <Search size={15} className="text-(--color-faint) shrink-0" />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="dw-palette-list"
            aria-activedescendant={rows[idx] ? `dw-pal-${rows[idx].key}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (i + 1) % rows.length); }
              if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (i - 1 + rows.length) % rows.length); }
              if (e.key === "Enter" && rows[idx]) run(rows[idx]);
              if (e.key === "Escape") onClose();
            }}
            placeholder="Jump to session, or search message contents…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-(--color-faint)"
          />
          <kbd className="text-tiny text-(--color-faint) border border-(--color-border) rounded px-1.5 py-0.5">esc</kbd>
        </div>
        {/* message-content search filters — only meaningful once a query runs */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-(--color-border) text-2xs">
          <select
            value={fCwd}
            onChange={(e) => setFCwd(e.target.value)}
            className="bg-transparent text-(--color-dim) outline-none max-w-[45%] truncate"
            title="Limit search to a project"
          >
            <option value="">All projects</option>
            {projects.map((c) => (
              <option key={c} value={c}>{c.replace(/^\/home\/[^/]+/, "~")}</option>
            ))}
          </select>
          <select
            value={fDays}
            onChange={(e) => setFDays(Number(e.target.value))}
            className="bg-transparent text-(--color-dim) outline-none"
            title="Limit search by age"
          >
            <option value={0}>All time</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <label className="flex items-center gap-1.5 text-(--color-dim) ml-auto shrink-0 cursor-pointer" title="Include tool-call output in results">
            <input
              type="checkbox"
              checked={fTools}
              onChange={(e) => setFTools(e.target.checked)}
              className="accent-(--color-accent)"
            />
            tool output
          </label>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1.5" role="listbox" id="dw-palette-list">
          {filtered.length > 0 && (
            <div className="px-3 py-1 text-tiny uppercase tracking-wider text-(--color-faint)">Sessions</div>
          )}
          {rows.map((r, i) => (
            <div key={r.key}>
              {i === firstHitIdx && (
                <div className="px-3 pt-2 pb-1 text-tiny uppercase tracking-wider text-(--color-faint)">
                  message contents
                </div>
              )}
              {i === firstActionIdx && (
                <div className="px-3 pt-2 pb-1 text-tiny uppercase tracking-wider text-(--color-faint)">
                  actions
                </div>
              )}
              <button
                id={`dw-pal-${r.key}`}
                role="option"
                aria-selected={i === idx}
                onMouseDown={(e) => { e.preventDefault(); run(r); }}
                onMouseEnter={() => setIdx(i)}
                className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-sm ${
                  i === idx ? "bg-(--color-panel2)" : ""
                }`}
                ref={(el) => { if (i === idx) el?.scrollIntoView({ block: "nearest" }); }}
              >
              {r.kind === "session" && <MessageSquare size={13} className="text-(--color-dim) shrink-0" />}
              {r.kind === "hit" && <Search size={13} className="text-(--color-violet) shrink-0" />}
              {r.kind === "action" && <Plus size={13} className="text-(--color-accent) shrink-0" />}
              <span className="flex-1 min-w-0">
                <span className="block truncate">{r.label}</span>
                {r.sub && <span className="block truncate text-2xs text-(--color-faint)">{r.sub}</span>}
              </span>
              {r.kind === "hit" && <FolderOpen size={11} className="text-(--color-faint) shrink-0" />}
              </button>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-(--color-faint)">No matches</div>
          )}
        </div>
    </Modal>
  );
}
