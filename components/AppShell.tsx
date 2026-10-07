"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import SessionSidebar from "./SessionSidebar";
import Welcome from "./Welcome";
import ChatWindow from "./ChatWindow";
import DirectoryPicker from "./DirectoryPicker";
import TranscriptView from "./TranscriptView";
import CommandPalette from "./CommandPalette";
import ShortcutsOverlay from "./ShortcutsOverlay";
import { ToastProvider, useToast } from "./Toasts";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";
import { decideAttach, type AttachPrior } from "@/lib/client/attach";
import type { JumpTarget } from "@/lib/client/jump";
import { api } from "@/lib/client/api";
import { onStreamState, streamSub } from "@/lib/client/stream";
import { useGlobalShortcuts, useMobileSidebarSwipe } from "@/hooks/useShellGestures";
import { notify, registerSw } from "@/lib/notify";
import { attentionDelta, pendingSnapshot } from "@/lib/client/attention";
import { cleanupTargets } from "@/lib/client/cleanupTargets";
import { displayTitle } from "@/lib/client/display";
import SettingsDialog from "./SettingsDialog";
import { applyTheme, loadThemePref, watchSystemTheme } from "@/lib/client/theme";
import { useUiPrefs } from "@/lib/client/uiPrefs";
import { budgetState, localDay } from "@/lib/client/budget";
import type { UsageReport } from "@/lib/usage";

export interface LockOwner {
  pid: number;
  cmdline: string;
  alive: boolean;
  ours: boolean;
  isDevin?: boolean;
  version?: string | null;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  isLocked?: boolean;
  lockedBy?: LockOwner;
  active?: boolean;
  running?: boolean;
  /** wanted attached, but the automatic re-attach after an acp restart failed */
  attachFailed?: boolean;
  /** agent→client requests awaiting an answer (permission/elicitation cards) */
  pendingRequests?: number;
  /** user-assigned tags (server-side `tags.json`, shared across devices) */
  tags?: string[];
  /** hidden from the sidebar's active list — kept, restorable (archive.json) */
  archived?: boolean;
  /** isolated-worktree session — cwd is $STATE_DIR/worktrees/<slug>, repo is
   *  the originating repository root */
  worktree?: { branch: string; repo: string };
  /** current model's display name (from persisted session_meta) */
  model?: string;
}

/** Drop per-session localStorage left behind by deleted sessions — drafts
 *  (`dw-draft-<id>`), plan-dock state and `dw-seen` entries. Only ever run
 *  against a non-empty server list, so a failed fetch can't wipe them. */
function pruneLocalState(live: Set<string>) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i) ?? "";
      const m = /^(?:dw-draft-|dw-plan-dock:|dw-review:)(.+)$/.exec(k);
      if (m && !live.has(m[1])) localStorage.removeItem(k);
    }
    const seen = JSON.parse(localStorage.getItem("dw-seen") ?? "{}") as Record<string, string>;
    const kept = Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
    if (Object.keys(kept).length !== Object.keys(seen).length) localStorage.setItem("dw-seen", JSON.stringify(kept));
  } catch {
    /* storage unavailable/corrupt — nothing to prune */
  }
}

const isMobile = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

/** Shallow URL update: keeps useSearchParams in sync without an RSC
 *  navigation (which would remount the Suspense boundary and lose toasts). */
const replaceUrl = (url: string) => window.history.replaceState(null, "", url);
/** New history entry — the browser/Android Back button returns to the
 *  previously open session. Next.js syncs useSearchParams with it. */
const pushUrl = (url: string) => window.history.pushState(null, "", url);

export default function AppShell() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Shell() {
  const params = useSearchParams();
  const selected = params.get("s");
  const readOnly = params.get("ro") === "1";
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean | null>(null);
  const [agentDown, setAgentDown] = useState(false);
  /** network unreachable (TypeError from fetch) — banner, not toast spam */
  const [offline, setOffline] = useState(false);
  /** first /api/sessions response arrived — until then `current` is unknown */
  const [listLoaded, setListLoaded] = useState(false);
  const attachPrior = useRef(new Map<string, AttachPrior>());
  /** search-hit scroll target for the currently selected session */
  const [jump, setJump] = useState<JumpTarget | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const driftedRef = useRef<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  /** per-session localStorage pruned once per page load */
  const gcDone = useRef(false);
  /** pendingRequests per session at the previous poll — null until the first */
  const pendingRef = useRef<Map<string, number> | null>(null);

  // unread tracking — baseline = first observed updatedAt; badge on later bumps.
  // SSR-safe: start empty, merge stored values in after mount (fresh observations win).
  const [seen, setSeen] = useState<Record<string, string>>({});
  useEffect(() => {
    // deferred: synchronous setState in an effect body causes a double render
    queueMicrotask(() => {
      try {
        const stored = JSON.parse(localStorage.getItem("dw-seen") ?? "{}") as Record<string, string>;
        setSeen((prev) => ({ ...stored, ...prev }));
      } catch {
        /* corrupt/absent */
      }
    });
  }, []);
  // functional update — a stale `seen` closure must not drop keys another
  // markSeen/refresh just wrote
  const markSeen = (id: string) =>
    setSeen((prev) => {
      const next = { ...prev, [id]: new Date().toISOString() };
      try {
        localStorage.setItem("dw-seen", JSON.stringify(next));
      } catch {
        /* quota/ignore */
      }
      return next;
    });

  // resolve initial sidebar state once on the client (open on desktop, closed on mobile)
  useEffect(() => {
    queueMicrotask(() => setSidebarOpen(!isMobile()));
    registerSw();
    applyTheme(loadThemePref()); // the boot script ran before Next's theme-color meta existed
    return watchSystemTheme();
  }, []);

  // mobile sidebar swipe — drag in from the left edge opens it, swiping
  // left while it's open closes it (mirrors the scrim tap)
  useMobileSidebarSwipe(sidebarOpen, setSidebarOpen);
  /** drawer (overlay) layout vs the docked desktop column */
  const [mobileDrawer, setMobileDrawer] = useState(false);
  // the phone drawer is a modal surface: focus moves into it on open and
  // returns to whatever opened it on close (screen readers, keyboards)
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerOpen = !!sidebarOpen && mobileDrawer;
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = drawerRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      if (prev && document.contains(prev)) prev.focus?.({ preventScroll: true });
    };
  }, [drawerOpen]);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setMobileDrawer(mq.matches);
    queueMicrotask(on);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // daily token budget — one warning per day per device, checked every
  // few minutes and whenever the tab comes back
  const { budget } = useUiPrefs();
  useEffect(() => {
    if (!budget) return;
    const check = () => {
      let warned: string | null = null;
      try {
        warned = localStorage.getItem("dw-budget-warned");
      } catch {
        /* treat as not warned */
      }
      if (warned === localDay()) return;
      api<UsageReport>("/api/usage")
        .then((r) => {
          const b = budgetState(r.daily, budget.dailyOutputTokens);
          if (!b?.over) return;
          try {
            localStorage.setItem("dw-budget-warned", localDay());
          } catch {
            /* may warn again next check */
          }
          toast(`Daily token budget crossed: ${b.used.toLocaleString()} / ${b.budget.toLocaleString()} output tokens today.`);
        })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 5 * 60_000);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [budget, toast]);
  // the mobile drawer is a modal surface: Escape closes it like any dialog
  useEffect(() => {
    if (!sidebarOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isMobile() && !e.defaultPrevented) setSidebarOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [sidebarOpen]);
  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);
  const toggleShortcuts = useCallback(() => setShortcutsOpen((v) => !v), []);
  // the config bar lives inside ChatWindow — reach it with a window event
  const openModelPicker = useCallback(
    () => window.dispatchEvent(new CustomEvent("dw-open-model-picker")),
    [],
  );
  useGlobalShortcuts({ onPalette: togglePalette, onShortcuts: toggleShortcuts, onModelPicker: openModelPicker });

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ sessions: SessionInfo[]; devinLatest?: string | null }>("/api/sessions");
      setSessions(r.sessions);
      // another session started waiting for input — its card isn't on screen,
      // so say so (an OS notification when this tab is hidden)
      for (const s of attentionDelta(pendingRef.current, r.sessions, selectedRef.current)) {
        const title = s.title || s.sessionId;
        if (document.hidden) notify(title, "Waiting for your input", `?s=${encodeURIComponent(s.sessionId)}`);
        else toast(`"${title}" is waiting for your input`, "info");
      }
      pendingRef.current = pendingSnapshot(r.sessions);
      if (!gcDone.current && r.sessions.length) {
        gcDone.current = true;
        pruneLocalState(new Set(r.sessions.map((s) => s.sessionId)));
      }
      setListLoaded(true);
      setAgentDown(false);
      setOffline(false);
      // baseline-seen for never-observed sessions; currently-open session stays seen
      const liveIds = new Set(r.sessions.map((s) => s.sessionId));
      setSeen((prev) => {
        let changed = false;
        const next = { ...prev };
        // deleted sessions leave the map (it is persisted wholesale)
        if (liveIds.size) {
          for (const id of Object.keys(next)) {
            if (!liveIds.has(id)) {
              delete next[id];
              changed = true;
            }
          }
        }
        for (const s of r.sessions) {
          if (!(s.sessionId in next)) {
            next[s.sessionId] = s.updatedAt ?? "";
            changed = true;
          } else if (s.sessionId === selectedRef.current) {
            next[s.sessionId] = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) {
          try {
            localStorage.setItem("dw-seen", JSON.stringify(next));
          } catch {
            /* quota/ignore */
          }
        }
        return changed ? next : prev;
      });
      // warn once per old devin version holding session locks
      if (r.devinLatest) {
        for (const s of r.sessions) {
          const v = s.lockedBy?.version;
          if (v && v !== r.devinLatest && !driftedRef.current.has(v)) {
            driftedRef.current.add(v);
            toast(
              `Session "${s.title || s.sessionId}" is held by devin ${v} (installed: ${r.devinLatest}) — "Take over" restarts it on the new version.`,
              "info",
            );
          }
        }
      }
    } catch (e) {
      // fetch TypeError = network blip (backgrounded tab, reconnecting tailnet…):
      // show the retryable banner and let the poll/SSE recover silently instead
      // of stacking "Failed to fetch" toasts on every resume.
      if (e instanceof TypeError) {
        setOffline(true);
      } else {
        setAgentDown(true);
        toast((e as Error).message);
      }
    }
  }, [toast]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    // sessions_changed can fire on every sqlite commit during streaming —
    // coalesce so a refresh runs at most once per 2s (trailing call keeps
    // the sidebar fresh without an ACP listSessions roundtrip per commit)
    let lastRun = 0;
    let pending: number | undefined;
    const throttledRefresh = () => {
      const wait = 2000 - (Date.now() - lastRun);
      if (wait <= 0 && !pending) {
        lastRun = Date.now();
        void refresh();
      } else if (!pending) {
        pending = window.setTimeout(() => {
          pending = undefined;
          lastRun = Date.now();
          void refresh();
        }, wait);
      }
    };
    // mux subscription — the tab's single /api/stream EventSource carries
    // global events; reconnects re-fire onStreamState → refetch to recover gaps
    const unsub = streamSub("global", "", (msg) => {
      const ev = msg.ev as { type?: string };
      try {
        if (ev?.type === "sessions_changed") throttledRefresh();
        if (ev?.type === "agent_exit") setAgentDown(true);
      } catch {
        /* noop */
      }
    });
    const unsubState = onStreamState((ok) => {
      if (ok) void refresh();
    });
    // discover sessions created elsewhere (CLI, other acp clients)
    const poll = setInterval(() => void refresh(), 15000);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      unsub();
      unsubState();
      clearInterval(poll);
      if (pending) clearTimeout(pending);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  const select = (s: SessionInfo | null, ro = false) => {
    if (s) markSeen(s.sessionId);
    // native history (not router.replace) — a router navigation would
    // re-render the dynamic page and remount the Suspense boundary, wiping
    // ToastProvider state. useSearchParams still tracks native history calls.
    // Switching sessions pushes an entry so Back returns to the previous one;
    // flipping the same session between chat and read-only replaces it.
    const url = s ? `?s=${encodeURIComponent(s.sessionId)}${ro ? "&ro=1" : ""}` : "?";
    if ((s?.sessionId ?? null) === selected) replaceUrl(url);
    else pushUrl(url);
    if (isMobile()) setSidebarOpen(false);
  };

  /** monotonic tag for jump targets — Date.now() is impure under the compiler lint */
  const jumpSeq = useRef(0);
  /** Open a session — plain pick, or a search hit that scrolls to the match. */
  const pick = (s: SessionInfo, match?: { nodeId: number; anchor?: string }) => {
    setJump(match ? { ...match, n: ++jumpSeq.current } : null);
    if (s.active || s.lockedBy?.ours) select(s);
    else void loadSession(s);
  };

  const unread = new Set(
    sessions
      .filter((s) => s.sessionId !== selected && s.updatedAt && seen[s.sessionId] && s.updatedAt > seen[s.sessionId])
      .map((s) => s.sessionId),
  );

  const createSession = async (cwd: string, opts?: { worktree?: boolean }) => {
    setShowPicker(false);
    try {
      const res = await api<{ sessionId: string; cwd?: string; worktree?: { branch: string } }>(
        "/api/sessions",
        { method: "POST", body: JSON.stringify({ cwd, worktree: opts?.worktree || undefined }) },
      );
      await refresh();
      pushUrl(`?s=${encodeURIComponent(res.sessionId)}`);
      if (res.worktree) toast(`Isolated worktree on ${res.worktree.branch}`, "info");
      if (isMobile()) setSidebarOpen(false);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  /** session/load; a lock error falls back to the read-only transcript.
   *  Returns true when the session is attached. */
  const attach = async (s: SessionInfo): Promise<boolean> => {
    try {
      await api(`/api/sessions/${s.sessionId}/load`, {
        method: "POST",
        body: JSON.stringify({ cwd: s.cwd }),
      });
      void refresh();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (/already open in another process|session_locked/i.test(msg)) {
        select(s, true); // fallback: read-only transcript
        void refresh(); // refresh lockedBy so the shown owner stays current
        const o = s.lockedBy;
        toast(
          `Still locked by ${o?.cmdline || "another process"}${o?.pid ? ` (pid ${o.pid})` : ""} — use "Take over" to force it.`,
        );
      } else {
        toast(msg);
      }
      return false;
    }
  };

  const loadSession = async (s: SessionInfo, force = false) => {
    // sessions locked by another live process open in read-only transcript view
    // (force skips this check so "Open for editing" actually retries the load)
    if (!force && s.isLocked && s.lockedBy && !s.lockedBy.ours && !s.active) {
      select(s, true);
      return;
    }
    attachPrior.current.set(s.sessionId, "inflight");
    const ok = await attach(s);
    attachPrior.current.set(s.sessionId, ok ? "ok" : "failed");
    if (ok) select(s);
  };

  const takeoverSession = async (s: SessionInfo) => {
    const o = s.lockedBy;
    const detail = o?.alive
      ? o.isDevin === false
        ? `\nThe lock points at pid ${o.pid} (${o.cmdline || "unknown"}), which is not devin — the stale lock will be removed, nothing is killed.`
        : `\nThis kills the holder: ${o.cmdline || "unknown"} (pid ${o.pid}).`
      : `\nThe recorded holder${o?.pid ? ` (pid ${o.pid})` : ""} is no longer running — this removes the stale lock, nothing is killed.`;
    if (
      (await confirm({
        title: `Take over "${s.title || s.sessionId}"?`,
        body: detail,
        confirmLabel: "Take over",
        danger: o?.alive === true && o?.isDevin !== false,
      })) !== "confirm"
    )
      return;
    try {
      await api(`/api/sessions/${s.sessionId}/takeover`, {
        method: "POST",
        body: JSON.stringify({ cwd: s.cwd }),
      });
      select(s);
      void refresh();
      toast(`Took over "${s.title || s.sessionId}"`, "info");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const deleteSession = async (s: SessionInfo) => {
    if (
      (await confirm({
        title: `Delete session "${s.title || s.sessionId}"?`,
        body: "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      })) !== "confirm"
    )
      return;
    try {
      const res = await api<{ leftoverWorktree?: { path: string; branch: string } }>(
        `/api/sessions/${s.sessionId}`,
        { method: "DELETE" },
      );
      if (selected === s.sessionId) select(null);
      if (res.leftoverWorktree) {
        toast(
          `Worktree ${res.leftoverWorktree.path} (${res.leftoverWorktree.branch}) was kept — remove it with \`bin/devin-web-ctl worktrees rm ${res.leftoverWorktree.path.split("/").pop()}\` when done.`,
          "info",
        );
      }
      void refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  /** Bulk housekeeping: delete sessions older than 7d that are not locked,
   *  not loaded in the web acp, not pinned, not archived (archived means
   *  "keep, just hide"), and not currently open. Pins come straight from the
   *  server — the localStorage mirror can be older than a pin set elsewhere. */
  const cleanupOld = async () => {
    const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    let pins: Set<string>;
    try {
      const s = await api<{ pins: string[] }>("/api/ui-state");
      pins = new Set(s.pins);
    } catch {
      // never delete while the real pin list is unknown
      toast("Cleanup skipped — couldn't load pins from the server.");
      return;
    }
    const targets = cleanupTargets(sessions, pins, selected, cutoff);
    if (!targets.length) {
      toast("Nothing to clean — no unlocked inactive sessions older than 7 days.");
      return;
    }
    const preview = targets
      .slice(0, 8)
      .map((t) => `• ${t.title || t.sessionId}`)
      .join("\n");
    if (
      (await confirm({
        title: `Delete ${targets.length} session(s) older than 7 days?`,
        body: `${preview}${targets.length > 8 ? "\n…" : ""}\n\nThis cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      })) !== "confirm"
    )
      return;
    let ok = 0;
    for (const t of targets) {
      try {
        await api(`/api/sessions/${t.sessionId}`, { method: "DELETE" });
        ok++;
      } catch {
        /* keep going — report partial success below */
      }
    }
    toast(`Deleted ${ok}/${targets.length} old session(s).`);
    void refresh();
  };

  /** selection-mode bulk delete — same guards as one-at-a-time delete:
   *  sessions held by another live process are skipped (the server would
   *  refuse them anyway) */
  const deleteMany = async (list: SessionInfo[]) => {
    const targets = list.filter((t) => !(t.isLocked && t.lockedBy && !t.lockedBy.ours));
    const skipped = list.length - targets.length;
    if (!targets.length) {
      toast("Nothing to delete — the selected sessions are open in another process.");
      return;
    }
    const preview = targets.slice(0, 8).map((t) => `• ${displayTitle(t.title, t.sessionId)}`).join("\n");
    if (
      (await confirm({
        title: `Delete ${targets.length} session(s)?`,
        body: `${preview}${targets.length > 8 ? "\n…" : ""}${skipped ? `\n\n${skipped} locked session(s) will be skipped.` : ""}\n\nThis cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      })) !== "confirm"
    )
      return;
    let ok = 0;
    for (const t of targets) {
      try {
        await api(`/api/sessions/${t.sessionId}`, { method: "DELETE" });
        ok++;
        if (selected === t.sessionId) select(null);
      } catch {
        /* partial success reported below */
      }
    }
    toast(`Deleted ${ok}/${targets.length} session(s).`, ok === targets.length ? "info" : undefined);
    void refresh();
  };

  const current = sessions.find((x) => x.sessionId === selected) ?? null;

  const attachRef = useRef(attach);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    attachRef.current = attach;
    refreshRef.current = refresh;
  });

  // URL-selected sessions (direct link, reload, server/acp restart) are listed
  // but not attached — attach them instead of letting sends fail silently
  useEffect(() => {
    if (!selected) return;
    const prior = attachPrior.current.get(selected);
    const d = decideAttach({ listLoaded, current, readOnly, prior });
    if (d === "recheck") {
      attachPrior.current.set(selected, "missing-checked");
      void refreshRef.current();
    } else if (d === "missing") {
      attachPrior.current.delete(selected);
      toast(`Session ${selected} no longer exists.`);
      replaceUrl("?");
    } else if (d === "attach" && current) {
      attachPrior.current.set(selected, "inflight");
      void attachRef.current(current).then((ok) =>
        attachPrior.current.set(current.sessionId, ok ? "ok" : "failed"),
      );
    }
  }, [selected, listLoaded, current, readOnly, sessions, toast]);

  return (
    <div className="flex h-full">
      {/* mobile scrim */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-(--color-scrim) backdrop-blur-[2px] z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div
        className={
          sidebarOpen ? "fixed inset-y-0 left-0 z-40 md:static outline-none" : "hidden md:block"
        }
        ref={drawerRef}
        {...(drawerOpen ? { role: "dialog", "aria-modal": true, "aria-label": "Sessions", tabIndex: -1 } : {})}
      >
        <SessionSidebar
          sessions={sessions}
          loaded={listLoaded}
          onDeleteMany={deleteMany}
          onSettings={() => setSettingsOpen(true)}
          selected={selected}
          unread={unread}
          open={sidebarOpen ?? true}
          onToggle={() => setSidebarOpen((v) => !(v ?? true))}
          onHome={() => select(null)}
          onSelect={pick}
          onNew={() => setShowPicker(true)}
          onNewInDir={(cwd) => void createSession(cwd)}
          onDelete={deleteSession}
          onTakeover={(s) => void takeoverSession(s)}
          onPalette={() => setPaletteOpen(true)}
          onRefresh={() => void refresh()}
          onCleanup={() => void cleanupOld()}
        />
      </div>
      <main className="flex-1 min-w-0 flex flex-col">
        {(offline || agentDown) && (
          <div className="bg-(--color-warning)/15 border-b border-(--color-warning)/30 text-(--color-warning) text-sm px-4 py-2">
            {offline
              ? "Connection lost — reconnecting automatically."
              : "devin acp process is not running — it will restart on the next action."}
            <button className="ml-2 underline underline-offset-2" onClick={() => { setOffline(false); setAgentDown(false); void refresh(); }}>retry</button>
          </div>
        )}
        {selected ? (
          !listLoaded ? (
            <div className="flex-1 flex items-center justify-center text-sm text-(--color-dim)">Loading…</div>
          ) : readOnly && current ? (
            <TranscriptView
              session={current}
              jump={jump}
              onRetry={() => void loadSession(current, true)}
              onTakeover={() => void takeoverSession(current)}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
          ) : (
            <ChatWindow
              sessionId={selected}
              cwd={current?.cwd ?? ""}
              jump={jump}
              detached={current?.attachFailed === true}
              onReattach={current ? () => void loadSession(current, true) : undefined}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
          )
        ) : (
          <Welcome
            sessions={sessions}
            unread={unread}
            onNew={() => setShowPicker(true)}
            onPick={pick}
            onMenu={() => setSidebarOpen(true)}
          />
        )}
      </main>
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          onSelect={pick}
          onNew={() => setShowPicker(true)}
          onClose={() => setPaletteOpen(false)}
          onModelPicker={selected ? openModelPicker : undefined}
        />
      )}
      {showPicker && (
        <DirectoryPicker
          initialCwd={current?.cwd}
          onPick={createSession}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
