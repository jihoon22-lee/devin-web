"use client";

import { Menu, Terminal } from "lucide-react";
import type { SessionInfo } from "./AppShell";
import { displayTitle, tildePath } from "@/lib/client/display";

function WelcomeSessionRow({
  s,
  onPick,
  badge,
}: {
  s: SessionInfo;
  onPick: (s: SessionInfo) => void;
  /** status emphasis — "input" for waiting cards, "run" for live turns,
   *  "new" for activity the user hasn't seen */
  badge?: "input" | "run" | "new";
}) {
  return (
    <button
      onClick={() => onPick(s)}
      className="flex items-center gap-2.5 px-3 py-3 md:py-2 rounded-xl border border-(--color-border) bg-(--color-panel) hover:bg-(--color-panel2) hover:border-(--color-border2) text-left transition"
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          badge === "input"
            ? "bg-(--color-status-input) animate-pulse"
            : badge === "run"
              ? "bg-(--color-accent) animate-pulse"
              : badge === "new"
                ? "bg-(--color-text)"
                : s.running
                ? "bg-(--color-accent) animate-pulse"
                : s.active
                  ? "bg-(--color-green)"
                  : "bg-(--color-faint)"
        }`}
      />
      <span className="flex-1 min-w-0">
        <span className={`block truncate text-sm text-(--color-text) ${badge === "new" ? "font-semibold" : ""}`}>
          {displayTitle(s.title, s.sessionId)}
        </span>
        <span className="block truncate text-2xs mono text-(--color-faint)">
          {tildePath(s.cwd)}
        </span>
      </span>
      {badge === "input" && (
        <span className="text-tiny uppercase tracking-wide text-(--color-status-input) shrink-0">
          needs input
        </span>
      )}
      {badge === "run" && (
        <span className="text-tiny uppercase tracking-wide text-(--color-accent) shrink-0">
          running
        </span>
      )}
    </button>
  );
}

function WelcomeSection({
  title,
  sessions,
  onPick,
  badge,
}: {
  title: string;
  sessions: SessionInfo[];
  onPick: (s: SessionInfo) => void;
  badge?: "input" | "run" | "new";
}) {
  if (!sessions.length) return null;
  return (
    <div className="w-full max-w-md">
      <div className="text-2xs uppercase tracking-wider text-(--color-faint) mb-2 px-1">
        {title}
      </div>
      <div className="flex flex-col gap-1">
        {sessions.map((s) => (
          <WelcomeSessionRow key={s.sessionId} s={s} onPick={onPick} badge={badge} />
        ))}
      </div>
    </div>
  );
}

export default function Welcome({
  sessions,
  onNew,
  onPick,
  onMenu,
  unread,
}: {
  sessions: SessionInfo[];
  /** sessions with activity since last viewed */
  unread?: Set<string>;
  onNew: () => void;
  onPick: (s: SessionInfo) => void;
  onMenu: () => void;
}) {
  const live = [...sessions]
    .filter((s) => !s.archived)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  // triage order: what needs me → what's working → what changed → the rest
  const needs = live.filter((s) => !!s.pendingRequests);
  const running = live.filter((s) => !s.pendingRequests && s.running).slice(0, 4);
  const fresh = live.filter((s) => !s.pendingRequests && !s.running && unread?.has(s.sessionId)).slice(0, 6);
  const recent = live
    .filter((s) => !s.pendingRequests && !s.running && !unread?.has(s.sessionId))
    .slice(0, Math.max(3, 6 - fresh.length));
  const empty = !needs.length && !running.length && !fresh.length && !recent.length;
  return (
    <div className="flex-1 flex flex-col items-center justify-start md:justify-center gap-6 text-(--color-dim) relative px-4 overflow-y-auto py-6 pt-[calc(3.5rem+env(safe-area-inset-top))] md:pt-6">
      <button
        onClick={onMenu}
        className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-3 md:hidden p-2 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2)"
        title="Sessions"
        aria-label="Open sidebar"
      >
        <Menu size={20} />
      </button>
      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-2xl bg-(--color-panel2) border border-(--color-border2) flex items-center justify-center">
          <Terminal size={26} className="text-(--color-accent)" />
        </div>
        <div className="text-2xl font-semibold text-(--color-text) tracking-tight">devin-web</div>
        <p className="text-sm">Web interface for Devin CLI — sessions live on this machine.</p>
      </div>
      <button
        onClick={onNew}
        className="px-4 py-2.5 rounded-xl bg-(--color-accent) text-black font-medium hover:brightness-110 transition"
      >
        New session
      </button>
      <WelcomeSection title="Needs input" sessions={needs} onPick={onPick} badge="input" />
      <WelcomeSection title="Running" sessions={running} onPick={onPick} badge="run" />
      <WelcomeSection title="New activity" sessions={fresh} onPick={onPick} badge="new" />
      <WelcomeSection title="Recent" sessions={recent} onPick={onPick} />
      {empty && <p className="text-sm">or pick a past session from the sidebar</p>}
    </div>
  );
}
