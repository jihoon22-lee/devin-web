"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, Command, Copy, Download, FolderOpen, Lock, LockOpen, MessageSquare,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, RefreshCw, Search, Trash2,
  AlertTriangle, BarChart3, Brush, GitBranch, MessageCircleQuestion, Tag, ListChecks, Square, CheckSquare, X, Settings,
} from "lucide-react";
import { FloatMenu, type MenuItem } from "./ContextMenu";
import { api } from "@/lib/client/api";
import { isImeComposing } from "@/lib/client/keys";
import { useStoredSet } from "@/hooks/useStoredSet";
import { useToast } from "./Toasts";
import UsageDialog from "./UsageDialog";
import DiagnosticsDialog from "./DiagnosticsDialog";
import Modal from "./Modal";
import type { Health } from "@/lib/client/health";
import type { SessionInfo } from "./AppShell";
import { displayTitle, tildePath } from "@/lib/client/display";

interface Props {
  sessions: SessionInfo[];
  /** the first /api/sessions response arrived — until then an empty list
   *  means "not loaded yet", not "no sessions" */
  loaded?: boolean;
  selected: string | null;
  unread: Set<string>;
  open: boolean;
  onToggle: () => void;
  onHome: () => void;
  onSelect: (s: SessionInfo) => void;
  onNew: () => void;
  onNewInDir: (cwd: string) => void;
  onDelete: (s: SessionInfo) => void;
  /** bulk delete from selection mode — confirms and reports itself */
  onDeleteMany?: (list: SessionInfo[]) => Promise<void>;
  onSettings?: () => void;
  onTakeover: (s: SessionInfo) => void;
  onPalette: () => void;
  onRefresh: () => void;
  /** bulk-delete old unlocked/inactive sessions (7d+ by default) */
  onCleanup: () => void;
}

function relTime(iso?: string | null) {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function lockTitle(s: SessionInfo): string {
  if (!s.isLocked) return "";
  const o = s.lockedBy;
  if (!o) return "Open in another process";
  if (o.ours) return "Open in devin-web";
  const cmd = o.cmdline || "unknown";
  return `Open in ${cmd} (pid ${o.pid})`;
}

/** Locked to another process but its transcript DB was just written —
 *  the CLI is very likely mid-turn. */
function cliActive(s: SessionInfo): boolean {
  if (!s.isLocked || !s.lockedBy || s.lockedBy.ours || !s.updatedAt) return false;
  const t = Date.parse(s.updatedAt);
  return !Number.isNaN(t) && Date.now() - t < 60_000;
}

/** a link click the browser should handle itself (new tab/window) */
const isOpenElsewhere = (e: React.MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0;

const SIDEBAR_KEY = "dw-sidebar-w";
const SIDEBAR_DEFAULT = 288;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;

/** the model most sessions in a list share — rows only label the outliers */
function commonModel(list: SessionInfo[]): string | undefined {
  const n = new Map<string, number>();
  for (const s of list) if (s.model) n.set(s.model, (n.get(s.model) ?? 0) + 1);
  let best: string | undefined;
  let max = 0;
  for (const [m, c] of n) if (c > max) [best, max] = [m, c];
  return best;
}

export default function SessionSidebar({
  sessions, loaded = true, selected, unread, open, onToggle, onHome, onSelect, onNew, onNewInDir, onDelete, onDeleteMany, onSettings,
  onTakeover, onPalette, onRefresh, onCleanup,
}: Props) {
  const toast = useToast();
  const [filter, setFilter] = useState("");
  /** "Needs input" — only sessions with unanswered permission/elicitation
   *  requests (pendingRequests comes from /api/sessions). */
  const [needsOnly, setNeedsOnly] = useState(false);
  const [pins, setPins] = useStoredSet("dw-pins");
  const [collapsed, setCollapsed] = useStoredSet("dw-collapsed");
  const [archOpen, setArchOpen] = useState(false);
  const [menu, setMenu] = useState<{ s: SessionInfo; x: number; y: number; el: Element | null } | null>(null);
  const [tagEdit, setTagEdit] = useState<SessionInfo | null>(null);
  const [tagText, setTagText] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  /** selection mode — null when off. Entered from the header button or a
   *  long press on a row (the phone gesture for "act on several") */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [bulkTag, setBulkTag] = useState(false);
  const longPress = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const lastPointer = useRef<string>("mouse");
  const togglePick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p ?? []);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pickedList = useMemo(
    () => (picked ? sessions.filter((s) => picked.has(s.sessionId)) : []),
    [picked, sessions],
  );
  const [sbw, setSbw] = useState(SIDEBAR_DEFAULT);
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const v = Number(localStorage.getItem(SIDEBAR_KEY));
        if (v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) setSbw(v);
      } catch {
        /* no storage — default width */
      }
    });
  }, []);
  const saveSbw = (w: number) => {
    const c = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
    setSbw(c);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(c));
    } catch {
      /* session-only */
    }
  };
  const sbDrag = useRef<{ x: number; w: number } | null>(null);

  // one visibility predicate for both the group list and the pinned row —
  // a filter that silently doesn't apply to pins would be confusing
  const visible = useMemo(
    () =>
      sessions.filter((s) => {
        if (needsOnly && !(s.pendingRequests ?? 0)) return false;
        if (!filter) return true;
        const f = filter.toLowerCase();
        return (
          (s.title ?? "").toLowerCase().includes(f) ||
          s.cwd.toLowerCase().includes(f) ||
          s.sessionId.toLowerCase().includes(f) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(f))
        );
      }),
    [sessions, filter, needsOnly],
  );

  // archived sessions leave every browsing surface (groups, pins, Alt+↑/↓
  // order) and collect in the collapsed section at the bottom — opening or
  // messaging them is unaffected
  const { active, archivedList } = useMemo(() => {
    const a: SessionInfo[] = [];
    const r: SessionInfo[] = [];
    for (const s of visible) (s.archived ? r : a).push(s);
    r.sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
    return { active: a, archivedList: r };
  }, [visible]);

  const groups = useMemo(() => {
    const byDir = new Map<string, SessionInfo[]>();
    for (const s of active) {
      // worktree sessions group under their source repo, not the
      // $STATE_DIR/worktrees/<slug> path — the chip marks the branch
      const dir = s.worktree?.repo ?? s.cwd;
      const list = byDir.get(dir) ?? [];
      list.push(s);
      byDir.set(dir, list);
    }
    for (const list of byDir.values()) {
      list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    }
    // project groups keep a FIXED alphabetical order — sorting them by the
    // newest session's activity made the whole sidebar reshuffle whenever
    // any session did anything (and even on a mere view, before updatedAt
    // became content-derived)
    return [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [active]);

  const pinned = useMemo(
    () => active.filter((s) => pins.has(s.sessionId))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    [active, pins],
  );

  // Alt+↑/↓ walks sessions in on-screen order (pinned first, then expanded
  // groups) — the list the eye scans; typing in any field is left alone
  const order = useMemo(() => {
    const seen = new Set<string>();
    const out: SessionInfo[] = [];
    for (const s of [...pinned, ...groups.filter(([dir]) => !collapsed.has(dir)).flatMap(([, l]) => l)]) {
      if (!seen.has(s.sessionId)) {
        seen.add(s.sessionId);
        out.push(s);
      }
    }
    return out;
  }, [pinned, groups, collapsed]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || !order.length) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      const i = order.findIndex((s) => s.sessionId === selected);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = order[i < 0 ? 0 : (i + step + order.length) % order.length];
      if (next && next.sessionId !== selected) onSelect(next);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [order, selected, onSelect]);

  const saveTags = async () => {
    if (!tagEdit || tagBusy) return;
    setTagBusy(true);
    try {
      const tags = tagText.split(",").map((t) => t.trim()).filter(Boolean);
      await api(`/api/sessions/${tagEdit.sessionId}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tags }),
      });
      setTagEdit(null);
      onRefresh();
    } catch (e) {
      toast(`Tags failed: ${(e as Error).message}`);
    } finally {
      setTagBusy(false);
    }
  };

  const toggleArchive = async (s: SessionInfo) => {
    try {
      await api(`/api/sessions/${s.sessionId}/archive`, {
        method: "PUT",
        body: JSON.stringify({ archived: !s.archived }),
      });
      onRefresh();
    } catch (e) {
      toast(`Archive failed: ${(e as Error).message}`);
    }
  };

  const bulkArchive = async (archived: boolean) => {
    const list = pickedList;
    let ok = 0;
    for (const s of list) {
      try {
        await api(`/api/sessions/${s.sessionId}/archive`, { method: "PUT", body: JSON.stringify({ archived }) });
        ok++;
      } catch {
        /* report partial success below */
      }
    }
    toast(`${archived ? "Archived" : "Unarchived"} ${ok}/${list.length}`, "info");
    setPicked(null);
    onRefresh();
  };

  const bulkSaveTags = async () => {
    const add = tagText.split(",").map((t) => t.trim()).filter(Boolean);
    if (!add.length) return setBulkTag(false);
    setTagBusy(true);
    let ok = 0;
    for (const s of pickedList) {
      try {
        const tags = [...new Set([...(s.tags ?? []), ...add])];
        await api(`/api/sessions/${s.sessionId}/tags`, { method: "PUT", body: JSON.stringify({ tags }) });
        ok++;
      } catch {
        /* partial */
      }
    }
    setTagBusy(false);
    setBulkTag(false);
    toast(`Tagged ${ok}/${pickedList.length}`, "info");
    setPicked(null);
    onRefresh();
  };

  const togglePin = (s: SessionInfo) =>
    setPins((p) => {
      const n = new Set(p);
      if (n.has(s.sessionId)) n.delete(s.sessionId);
      else n.add(s.sessionId);
      return n;
    });

  const toggleGroup = (dir: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      return n;
    });

  const menuItems = (s: SessionInfo): MenuItem[] => [
    { label: "Open", icon: <MessageSquare size={13} />, onClick: () => onSelect(s) },
    ...(s.isLocked && s.lockedBy && !s.lockedBy.ours
      ? [{ label: "Take over", icon: <LockOpen size={13} />, onClick: () => onTakeover(s) }]
      : []),
    {
      label: pins.has(s.sessionId) ? "Unpin" : "Pin",
      icon: pins.has(s.sessionId) ? <PinOff size={13} /> : <Pin size={13} />,
      onClick: () => togglePin(s),
    },
    {
      label: s.archived ? "Unarchive" : "Archive",
      icon: s.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />,
      onClick: () => void toggleArchive(s),
    },
    {
      label: "Edit tags…",
      icon: <Tag size={13} />,
      onClick: () => {
        setTagText((s.tags ?? []).join(", "));
        setTagEdit(s);
      },
    },
    {
      label: "Copy session ID",
      icon: <Copy size={13} />,
      onClick: () => void navigator.clipboard.writeText(s.sessionId).catch(() => {}),
    },
    {
      label: "Export markdown",
      icon: <Download size={13} />,
      onClick: () => window.open(`/api/sessions/${s.sessionId}/export`, "_blank"),
    },
    {
      label: "Export JSON",
      icon: <Download size={13} />,
      onClick: () => window.open(`/api/sessions/${s.sessionId}/export?format=json`, "_blank"),
    },
    // deleting a session open in another devin process would destroy it
    // under a live holder — the server refuses too; take over first
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      disabled: !!(s.isLocked && s.lockedBy && !s.lockedBy.ours),
      onClick: () => onDelete(s),
    },
  ];

  if (!open) {
    return (
      <div className="w-11 border-r border-(--color-border) bg-(--color-panel) flex flex-col items-center py-2.5 gap-1.5 h-full">
        <button onClick={onToggle} className="p-1.5 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2)" title="Open sidebar">
          <PanelLeftOpen size={16} />
        </button>
        <button onClick={onNew} className="p-1.5 rounded-lg text-(--color-dim) hover:text-white hover:bg-(--color-panel2)" title="New session">
          <Plus size={16} />
        </button>
      </div>
    );
  }

  const renderRow = (s: SessionInfo, groupModel?: string) => {
    const isUnread = unread.has(s.sessionId);
    return (
    <div
      key={s.sessionId}
      onClick={() => {
        if (longPress.current?.fired) return; // the long press already acted
        if (picked) togglePick(s.sessionId);
        else onSelect(s);
      }}
      onPointerDown={(e) => {
        lastPointer.current = e.pointerType;
        if (e.pointerType !== "touch") return;
        const lp = { x: e.clientX, y: e.clientY, fired: false, t: setTimeout(() => {
          lp.fired = true;
          navigator.vibrate?.(10);
          setPicked((p) => new Set([...(p ?? []), s.sessionId]));
        }, 500) };
        longPress.current = lp;
      }}
      onPointerMove={(e) => {
        const lp = longPress.current;
        if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) clearTimeout(lp.t);
      }}
      onPointerUp={() => {
        const lp = longPress.current;
        if (lp && !lp.fired) clearTimeout(lp.t);
        // the click that follows a fired long press is swallowed above,
        // then the marker clears for the next tap
        setTimeout(() => { if (longPress.current === lp) longPress.current = null; }, 0);
      }}
      onPointerCancel={() => {
        if (longPress.current) clearTimeout(longPress.current.t);
        longPress.current = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (lastPointer.current === "touch") return; // long press = select on phones
        setMenu({ s, x: e.clientX, y: e.clientY, el: e.currentTarget });
      }}
      className={`group relative flex items-center gap-2 px-2.5 py-2.5 md:py-2 rounded-lg cursor-pointer text-sm transition-colors focus-within:bg-(--color-panel2) select-none md:select-auto [-webkit-touch-callout:none] ${
        picked?.has(s.sessionId)
          ? "bg-(--color-accent)/20 text-white"
          : selected === s.sessionId
          ? "bg-(--color-accent)/15 text-white"
          : "hover:bg-(--color-panel2) text-(--color-text)"
      } ${s.archived ? "opacity-60" : ""}`}
    >
      <span
        className="shrink-0 w-3.5 flex items-center justify-center"
        title={
          s.attachFailed
            ? "Could not re-attach after the agent restarted — click to retry"
            : cliActive(s)
              ? `${lockTitle(s)} — likely working`
              : lockTitle(s)
        }
      >
        {picked ? (
          picked.has(s.sessionId) ? (
            <CheckSquare size={14} className="text-(--color-accent)" aria-label="Selected" />
          ) : (
            <Square size={14} className="text-(--color-faint)" aria-label="Not selected" />
          )
        ) : s.attachFailed ? (
          <AlertTriangle size={11} className="text-(--color-red)" />
        ) : s.running ? (
          <span className="w-1.5 h-1.5 rounded-full bg-(--color-accent) animate-pulse" />
        ) : cliActive(s) ? (
          <span className="w-1.5 h-1.5 rounded-full bg-(--color-status-running) animate-pulse" />
        ) : s.isLocked && s.lockedBy && !s.lockedBy.ours ? (
          <Lock size={11} className="text-(--color-status-locked)" />
        ) : s.active || s.lockedBy?.ours ? (
          <span className="w-1.5 h-1.5 rounded-full bg-(--color-green)" />
        ) : (
          <MessageSquare size={11} className="text-(--color-faint)" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        {/* real link — Tab-reachable, openable in a new tab, and shows a
            focus ring; the row's div onClick still covers mouse clicks on
            the padding around it */}
        <a
          href={`?s=${encodeURIComponent(s.sessionId)}`}
          onClick={(e) => {
            e.stopPropagation();
            // Ctrl/Cmd/Shift/middle click: let the browser open a new tab
            if (isOpenElsewhere(e) && !picked) return;
            e.preventDefault();
            if (longPress.current?.fired) return;
            if (picked) togglePick(s.sessionId);
            else onSelect(s);
          }}
          className={`block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:text-white ${
            isUnread ? "font-semibold text-white" : ""
          }`}
          title={s.title ?? s.sessionId}
        >
          {displayTitle(s.title, s.sessionId)}
        </a>
        {s.model && s.model !== groupModel && (
          <span className="block truncate text-tiny text-(--color-faint)" title={s.model}>
            {s.model}
          </span>
        )}
        {s.worktree && (
          <span
            className="mono text-tiny px-1 rounded bg-(--color-accent)/15 text-(--color-accent) inline-flex items-center gap-0.5 mt-0.5"
            title={`Isolated worktree: ${s.worktree.branch}\n${s.cwd}`}
          >
            <GitBranch size={9} />
            {s.worktree.branch.replace(/^devin-web\//, "")}
          </span>
        )}
        {!!s.tags?.length && (
          <span className="flex flex-wrap gap-1 mt-0.5">
            {s.tags.slice(0, 3).map((t) => (
              <span key={t} className="mono text-tiny px-1 rounded bg-(--color-accent)/10 text-(--color-dim)">
                #{t}
              </span>
            ))}
            {s.tags.length > 3 && (
              <span className="text-tiny text-(--color-faint)">+{s.tags.length - 3}</span>
            )}
          </span>
        )}
      </span>
      {!!s.pendingRequests && (
        <span
          className="flex items-center gap-0.5 text-(--color-status-input) shrink-0"
          title="Waiting for input — permission or question pending"
        >
          <MessageCircleQuestion size={12} />
          {s.pendingRequests > 1 && <span className="text-tiny">{s.pendingRequests}</span>}
        </span>
      )}
      {isUnread && (
        // neutral, not accent — the accent pulse already means "running"
        <span className="w-2 h-2 rounded-full bg-(--color-text) shrink-0" title="New activity" aria-label="Unread" />
      )}
      {pins.has(s.sessionId) && <Pin size={10} className="shrink-0 text-(--color-faint) -rotate-45" />}
      <span className="text-tiny text-(--color-faint) shrink-0 md:group-hover:hidden md:group-focus-within:hidden">
        {relTime(s.updatedAt)}
      </span>
      {/* opacity (not display) keeps the button Tab-reachable on desktop;
          it appears on row hover, row focus, or when it itself is focused */}
      {!picked && <button
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ s, x: r.right - 170, y: r.bottom + 4, el: e.currentTarget });
        }}
        className="flex md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus-visible:opacity-100 p-2 -m-1.5 md:p-1 md:-m-1 rounded text-(--color-dim) hover:text-white hover:bg-(--color-panel3) shrink-0"
        title="Session actions"
        aria-label="Session actions"
      >
        <MoreHorizontal size={15} className="md:w-[13px] md:h-[13px]" />
      </button>}
    </div>
    );
  };

  const renderGroup = ([dir, list]: [string, SessionInfo[]]) => {
    const isCollapsed = collapsed.has(dir);
    const groupModel = commonModel(list);
    return (
      <div key={dir} className="mt-2 first:mt-0">
        <div className="group/dir flex items-center gap-1 px-2 py-1 rounded-md mb-1 bg-(--color-panel2)/70 border border-(--color-border)/70">
          <button
            onClick={() => toggleGroup(dir)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
            title={dir}
          >
            {isCollapsed ? (
              <ChevronRight size={11} className="shrink-0 text-(--color-faint)" />
            ) : (
              <ChevronDown size={11} className="shrink-0 text-(--color-faint)" />
            )}
            <FolderOpen size={12} className="shrink-0 text-(--color-folder)" />
            {/* the leaf dir is what distinguishes groups — rtl overflow
                clips the parent side so the leaf stays visible. The LRM
                marks keep the path's own order: inside an rtl box the
                neutral "~/" would otherwise reorder to the end */}
            <span
              className="truncate flex-1 mono text-2xs font-medium text-(--color-dim)"
              style={{ direction: "rtl", textAlign: "left" }}
            >
              {`\u200E${tildePath(dir)}\u200E`}
            </span>
            <span className="text-tiny px-1.5 py-px rounded-full bg-(--color-panel3) text-(--color-faint) shrink-0">
              {list.length}
            </span>
          </button>
          <button
            onClick={() => onNewInDir(dir)}
            className="p-1 rounded opacity-70 md:opacity-0 md:group-hover/dir:opacity-100 md:group-focus-within/dir:opacity-100 focus-visible:opacity-100 hover:bg-(--color-panel3) hover:text-white shrink-0 text-(--color-dim)"
            title={`New session in ${dir}`}
            aria-label={`New session in ${dir}`}
          >
            <Plus size={13} />
          </button>
        </div>
        {!isCollapsed && (
          <div className="ml-[13px] pl-1.5 border-l border-(--color-border)/70 flex flex-col gap-0.5">
            {list.map((x) => renderRow(x, groupModel))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className="relative w-[85vw] max-w-sm md:max-w-none md:w-(--dw-sb-w) shrink-0 border-r border-(--color-border) bg-(--color-panel) flex flex-col h-full pt-[env(safe-area-inset-top)]"
      style={{ "--dw-sb-w": `${sbw}px` } as React.CSSProperties}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={sbw}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-label="Resize sidebar"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        className="hidden md:block absolute top-0 -right-1 h-full w-2 z-10 cursor-col-resize hover:bg-(--color-accent)/30 active:bg-(--color-accent)/50"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          sbDrag.current = { x: e.clientX, w: sbw };
        }}
        onPointerMove={(e) => {
          const d = sbDrag.current;
          if (d) setSbw(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, d.w + e.clientX - d.x)));
        }}
        onPointerUp={() => {
          if (!sbDrag.current) return;
          sbDrag.current = null;
          saveSbw(sbw);
        }}
        onDoubleClick={() => saveSbw(SIDEBAR_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          saveSbw(sbw + (e.key === "ArrowRight" ? 16 : -16));
        }}
      />
      <div className="flex items-center gap-1 px-3 py-2.5 border-b border-(--color-border)">
        <button
          onClick={onHome}
          className="flex items-center gap-2 font-semibold text-sm flex-1 text-left hover:text-white min-w-0"
          title="Back to home"
        >
          <span className="w-5 h-5 rounded-md bg-(--color-accent)/20 flex items-center justify-center shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-(--color-accent)" />
          </span>
          devin-web
        </button>
        <button
          onClick={onPalette}
          className="p-2 md:p-1.5 rounded-lg hover:bg-(--color-panel2) text-(--color-dim) hover:text-white"
          title="Jump to session (Ctrl+K)"
          aria-label="Session palette"
        >
          <Command size={13} />
        </button>
        <button
          onClick={() => setPicked((p) => (p ? null : new Set()))}
          className={`p-2 md:p-1.5 rounded-lg hover:bg-(--color-panel2) hover:text-white ${picked ? "text-(--color-accent) bg-(--color-accent)/15" : "text-(--color-dim)"}`}
          title={picked ? "Exit selection" : "Select sessions"}
          aria-label="Select sessions"
          aria-pressed={!!picked}
        >
          <ListChecks size={15} />
        </button>
        <button onClick={onRefresh} className="hidden md:block p-1.5 rounded-lg hover:bg-(--color-panel2) text-(--color-dim) hover:text-white" title="Refresh sessions" aria-label="Refresh sessions">
          <RefreshCw size={14} />
        </button>
        <button onClick={onNew} className="p-2 md:p-1.5 rounded-lg hover:bg-(--color-panel2) text-(--color-dim) hover:text-white" title="New session" aria-label="New session">
          <Plus size={16} />
        </button>
        <button onClick={onToggle} className="p-2 md:p-1.5 rounded-lg hover:bg-(--color-panel2) text-(--color-dim) hover:text-white" title="Close sidebar" aria-label="Close sidebar">
          <PanelLeftClose size={15} />
        </button>
      </div>
      <div className="px-2.5 py-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-(--color-faint) pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sessions…"
            className="w-full bg-(--color-panel2) border border-(--color-border) rounded-lg pl-8 pr-9 py-1.5 text-sm outline-none focus:border-(--color-accent)/60 placeholder:text-(--color-faint)"
          />
          <button
            onClick={() => setNeedsOnly((v) => !v)}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md ${
              needsOnly
                ? "text-(--color-status-input) bg-(--color-status-input)/15"
                : "text-(--color-faint) hover:text-(--color-dim)"
            }`}
            title={needsOnly ? "Showing only sessions waiting for input" : "Only sessions waiting for input"}
            aria-pressed={needsOnly}
          >
            <MessageCircleQuestion size={13} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {pinned.length > 0 && (
          <div className="mt-2 first:mt-0">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md mb-1 bg-(--color-panel2)/70 border border-(--color-border)/70">
              <Pin size={11} className="shrink-0 -rotate-45 text-(--color-accent)" />
              <span className="flex-1 text-2xs font-medium text-(--color-dim)">Pinned</span>
              <span className="text-tiny px-1.5 py-px rounded-full bg-(--color-panel3) text-(--color-faint)">{pinned.length}</span>
            </div>
            <div className="ml-[13px] pl-1.5 border-l border-(--color-border)/70 flex flex-col gap-0.5">
              {pinned.map((x) => renderRow(x, commonModel(pinned)))}
            </div>
          </div>
        )}
        {groups.map(renderGroup)}
        {groups.length === 0 && pinned.length === 0 && (
          !loaded ? (
            <div className="flex flex-col gap-2 mt-2" aria-busy="true" aria-label="Loading sessions">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-9 rounded-lg bg-(--color-panel2) animate-pulse" />
              ))}
            </div>
          ) : filter || needsOnly ? (
            <div className="text-center text-(--color-faint) text-sm mt-10 px-4">
              No sessions match{filter ? ` "${filter}"` : ""}
              {needsOnly ? " waiting for input" : ""}.
              <button
                onClick={() => { setFilter(""); setNeedsOnly(false); }}
                className="block mx-auto mt-2 text-(--color-accent) underline underline-offset-2"
              >
                Clear filter
              </button>
            </div>
          ) : (
            <div className="text-center text-(--color-faint) text-sm mt-10">
              No sessions yet.
              <button onClick={onNew} className="block mx-auto mt-2 text-(--color-accent) underline underline-offset-2">
                Start one
              </button>
            </div>
          )
        )}
        {archivedList.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setArchOpen((v) => !v)}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md mb-1 bg-(--color-panel2)/70 border border-(--color-border)/70 text-left"
              aria-expanded={archOpen}
            >
              {archOpen ? (
                <ChevronDown size={11} className="shrink-0 text-(--color-faint)" />
              ) : (
                <ChevronRight size={11} className="shrink-0 text-(--color-faint)" />
              )}
              <Archive size={12} className="shrink-0 text-(--color-faint)" />
              <span className="flex-1 text-2xs font-medium text-(--color-dim)">Archived</span>
              <span className="text-tiny px-1.5 py-px rounded-full bg-(--color-panel3) text-(--color-faint) shrink-0">
                {archivedList.length}
              </span>
            </button>
            {archOpen && (
              <div className="ml-[13px] pl-1.5 border-l border-(--color-border)/70 flex flex-col gap-0.5">
                {archivedList.map((x) => renderRow(x, commonModel(archivedList)))}
              </div>
            )}
          </div>
        )}
      </div>
      {picked ? (
        <div className="border-t border-(--color-border) px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] flex items-center gap-1 bg-(--color-panel2)">
          <span className="text-xs text-(--color-dim) px-1 mr-auto">{picked.size} selected</span>
          <button
            disabled={!picked.size}
            onClick={() => void bulkArchive(!pickedList.every((x) => x.archived))}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-(--color-text) hover:bg-(--color-panel3) disabled:opacity-40"
          >
            {pickedList.length && pickedList.every((x) => x.archived) ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {pickedList.length && pickedList.every((x) => x.archived) ? "Unarchive" : "Archive"}
          </button>
          <button
            disabled={!picked.size}
            onClick={() => { setTagText(""); setBulkTag(true); }}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-(--color-text) hover:bg-(--color-panel3) disabled:opacity-40"
          >
            <Tag size={14} /> Tag
          </button>
          {onDeleteMany && <button
            disabled={!picked.size}
            onClick={() => void onDeleteMany(pickedList).then(() => setPicked(null))}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-(--color-danger) hover:bg-(--color-danger)/10 disabled:opacity-40"
          >
            <Trash2 size={14} /> Delete
          </button>}
          <button
            onClick={() => setPicked(null)}
            className="p-2 rounded-lg text-(--color-dim) hover:bg-(--color-panel3)"
            aria-label="Exit selection"
            title="Exit selection"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <div className="border-t border-(--color-border) px-2 py-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))] flex items-center gap-1">
          <button
            onClick={onCleanup}
            className="flex items-center gap-1.5 px-1.5 py-2 md:py-1 text-2xs text-(--color-faint) hover:text-(--color-dim) transition-colors"
            title="Delete unlocked, inactive sessions older than 7 days"
          >
            <Brush size={12} /> Clean up
          </button>
          <button
            onClick={() => setUsageOpen(true)}
            className="p-2 md:p-1 rounded text-(--color-faint) hover:text-(--color-dim) transition-colors"
            title="Token & cost usage"
            aria-label="Token & cost usage"
          >
            <BarChart3 size={14} />
          </button>
          {onSettings && <button
            onClick={onSettings}
            className="p-2 md:p-1 rounded text-(--color-faint) hover:text-(--color-dim) transition-colors"
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={14} />
          </button>}
          <HealthBadge />
        </div>
      )}
      {menu && (
        <FloatMenu x={menu.x} y={menu.y} anchor={menu.el} items={menuItems(menu.s)} onClose={() => setMenu(null)} />
      )}
      {usageOpen && <UsageDialog onClose={() => setUsageOpen(false)} />}
      {bulkTag && (
        <Modal onClose={() => setBulkTag(false)} label="Add tags"
          panelClassName="w-full max-w-xs rounded-xl border border-(--color-border) bg-(--color-panel) p-4 shadow-xl"
        >
          <div className="text-sm font-medium mb-1">Add tags to {pickedList.length} session(s)</div>
          <input
            autoFocus
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter") void bulkSaveTags();
              if (e.key === "Escape") setBulkTag(false);
            }}
            placeholder="comma-separated tags…"
            className="w-full mt-2 bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-base md:text-sm outline-none focus:border-(--color-accent)/60 placeholder:text-(--color-faint)"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => setBulkTag(false)} className="px-3 py-2 rounded-lg text-xs text-(--color-dim) hover:text-white">Cancel</button>
            <button onClick={() => void bulkSaveTags()} disabled={tagBusy} className="px-3 py-2 rounded-lg bg-(--color-accent) text-black text-xs font-medium disabled:opacity-40">Add</button>
          </div>
        </Modal>
      )}
      {tagEdit && (
        <Modal onClose={() => setTagEdit(null)} label="Edit tags"
          panelClassName="w-full max-w-xs rounded-xl border border-(--color-border) bg-(--color-panel) p-4 shadow-xl"
        >
            <div className="text-sm font-medium mb-1 truncate">Tags</div>
            <div className="text-2xs text-(--color-dim) mb-2 truncate">
              {tagEdit.title || tagEdit.sessionId}
            </div>
            <input
              autoFocus
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return; // Enter commits the Hangul syllable, not the form
                if (e.key === "Enter") void saveTags();
                if (e.key === "Escape") setTagEdit(null);
              }}
              placeholder="comma-separated tags…"
              className="w-full bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-sm outline-none focus:border-(--color-accent)/60 placeholder:text-(--color-faint)"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setTagEdit(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-(--color-dim) hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveTags()}
                disabled={tagBusy}
                className="px-3 py-1.5 rounded-lg bg-(--color-accent) text-black text-xs font-medium disabled:opacity-40"
              >
                Save
              </button>
            </div>
        </Modal>
      )}
    </aside>
  );
}

/** acp liveness, attach count and devin CLI version/login from /api/health.
 *  An unreachable server resets the badge to "unknown" instead of keeping
 *  the last green state. */
export function HealthBadge() {
  const toast = useToast();
  const [diag, setDiag] = useState(false);
  const [h, setH] = useState<Health | null>(null);
  const prev = useRef<Health | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Health>("/api/health")
        .then((r) => {
          if (cancelled) return;
          const p = prev.current;
          // alert only on TRANSITIONS — a red baseline that re-toasts every
          // 30s is noise; the badge itself already shows steady-state
          if (p) {
            if (p.host === true && r.host === false)
              toast("Terminal host unreachable — terminal connections degraded");
            if (p.host === false && r.host === true)
              toast("Terminal host reconnected", "info");
            if (!p.acp.degraded && r.acp.degraded)
              toast(`Agent degraded: ${r.acp.degraded} — restart when idle: ctl acpd restart --when-idle`);
            if (p.cliSchema?.status !== "drift" && r.cliSchema?.status === "drift")
              toast(`CLI schema mismatch: ${r.cliSchema.missing.join(", ")}`);
            if (p.cliSchema?.status !== "unavailable" && r.cliSchema?.status === "unavailable")
              toast("CLI schema unavailable: sessions.db could not be read");
            if (p.cliSchema?.ok === false && r.cliSchema?.status === "compatible")
              toast("CLI schema check recovered", "info");
          }
          prev.current = r;
          setH(r);
        })
        .catch(() => {
          if (cancelled) return;
          prev.current = null; // re-baseline silently on the next good poll
          setH(null);
        });
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [toast]);
  const up = h?.acp.alive;
  const degraded = h?.acp.degraded;
  const loggedOut = h?.devin?.authed === false;
  const schemaProblem = h?.cliSchema?.ok === false;
  const schemaDetail = h?.cliSchema?.status === "drift"
    ? `CLI schema mismatch: ${h.cliSchema.missing.join(", ")}`
    : h?.cliSchema?.status === "unavailable"
      ? "CLI schema unavailable: sessions.db could not be read"
      : null;
  const mins = h ? Math.floor(h.uptime / 60) : 0;
  const version = h?.devin?.version ? `devin ${h.devin.version}` : "devin version unknown";
  const title = h
    ? `${version}${loggedOut ? " — NOT logged in (see 'devin auth --help')" : ""}\n` +
      (schemaDetail ? `${schemaDetail} (migration ${h.cliSchema?.version ?? "unknown"})\n` : "") +
      (degraded
        ? `acp DEGRADED — ${degraded}\nrestart the daemon when ready: bin/devin-web-ctl acpd restart --when-idle`
        : `acp ${up ? `running (pid ${h.acp.pid})` : "not running"} — ${h.attached} attached, up ${mins}m`)
    : "server unreachable";
  return (
    <>
      <button
        type="button"
        onClick={() => setDiag(true)}
        className={`ml-auto flex items-center gap-1 text-tiny shrink-0 ${
          loggedOut || degraded || schemaProblem ? "text-(--color-red)" : "text-(--color-faint)"
        }`}
        title={title}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            h == null
              ? "bg-(--color-faint)"
              : loggedOut || degraded || schemaProblem
                ? "bg-(--color-red)"
                : up
                  ? "bg-(--color-green)"
                  : "bg-(--color-dim)"
          }`}
        />
        {schemaProblem ? "schema" : loggedOut ? "login" : degraded ? "degraded" : "acp"}
      </button>
      {diag && <DiagnosticsDialog onClose={() => setDiag(false)} />}
    </>
  );
}
