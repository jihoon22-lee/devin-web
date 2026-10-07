"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { MessageSquare, Search, Wrench, Brain, Bot, X } from "lucide-react";
import Modal from "./Modal";
import type { ChatItem } from "@/lib/client/model";
import { fmtMessageTime } from "@/lib/client/turnSummary";

interface Hit {
  /** rendered item id, or `node-<n>` for a server outline row not loaded yet */
  id: string;
  nodeId?: number;
  kind: "user" | "agent" | "thought" | "tool";
  text: string;
  /** match offset into `text` (-1 for outline rows) */
  at: number;
  ts?: number;
}

const ICON = {
  user: <MessageSquare size={14} />,
  agent: <Bot size={14} />,
  thought: <Brain size={14} />,
  tool: <Wrench size={14} />,
};

function searchable(it: ChatItem): { kind: Hit["kind"]; text: string; ts?: number } | null {
  if (it.kind === "text") return { kind: it.role, text: it.text, ts: it.ts };
  if (it.kind === "tool") {
    const body = (it.tool.content ?? [])
      .map((c) => {
        const b = c as { type?: string; content?: { text?: unknown }; newText?: unknown };
        return typeof b.content?.text === "string" ? b.content.text : typeof b.newText === "string" ? b.newText : "";
      })
      .join("\n");
    return { kind: "tool", text: `${it.tool.title ?? ""}\n${body}`, ts: it.ts };
  }
  return null;
}

/** Pure search over the loaded transcript — exported for tests. Empty
 *  query = the outline: every user prompt, newest last. */
export function findInItems(items: ChatItem[], query: string, limit = 200): Hit[] {
  const q = query.trim().toLowerCase();
  const out: Hit[] = [];
  for (const it of items) {
    const s = searchable(it);
    if (!s) continue;
    if (!q) {
      if (s.kind === "user") out.push({ id: it.id, kind: "user", text: s.text, at: -1, ts: s.ts });
      continue;
    }
    const at = s.text.toLowerCase().indexOf(q);
    if (at >= 0) out.push({ id: it.id, kind: s.kind, text: s.text, at, ts: s.ts });
    if (out.length >= limit) break;
  }
  return out;
}

function Snippet({ hit, q }: { hit: Hit; q: string }) {
  if (hit.at < 0) return <span className="line-clamp-2 whitespace-pre-wrap break-keep wrap-anywhere">{hit.text.trim()}</span>;
  const from = Math.max(0, hit.at - 40);
  const pre = (from ? "…" : "") + hit.text.slice(from, hit.at);
  const mid = hit.text.slice(hit.at, hit.at + q.length);
  const post = hit.text.slice(hit.at + q.length, hit.at + q.length + 120);
  return (
    <span className="line-clamp-2 break-keep wrap-anywhere">
      {pre.replace(/\s+/g, " ")}
      <mark className="bg-(--color-warning)/30 text-(--color-text) rounded-sm px-0.5">{mid}</mark>
      {post.replace(/\s+/g, " ")}
    </span>
  );
}

/** Find-in-session + prompt outline as one bottom sheet: on a phone, long
 *  sessions are otherwise scrolled by thumb for minutes. Searches what is
 *  loaded; older history loads on request. */
/** The outline: every prompt on the chain (server list, durable) plus any
 *  live-turn prompt only the loaded items have yet. */
export function mergeOutline(
  items: ChatItem[],
  server: { nodeId: number; text: string; ts?: number }[] | null,
): Hit[] {
  const local = findInItems(items, "");
  if (!server) return local;
  const known = new Set(server.map((p) => `bf-${p.nodeId}`));
  return [
    ...server.map((p) => ({ id: `bf-${p.nodeId}`, nodeId: p.nodeId, kind: "user" as const, text: p.text, at: -1, ts: p.ts })),
    ...local.filter((h) => !known.has(h.id) && !h.id.startsWith("bf-")),
  ];
}

export default function FindSheet({
  sessionId,
  items,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  onJump,
  onJumpNode,
  onClose,
}: {
  sessionId?: string;
  items: ChatItem[];
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onJump: (id: string) => void;
  /** jump to a durable node that isn't loaded yet (pages history in) */
  onJumpNode?: (nodeId: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [outline, setOutline] = useState<{ nodeId: number; text: string; ts?: number }[] | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api<{ prompts: { nodeId: number; text: string; ts?: number }[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`)
      .then((r) => !cancelled && setOutline(r.prompts))
      .catch(() => {}); // the loaded items still give a partial outline
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  const searching = q.trim().length >= 2;
  const hits = useMemo(
    () => (searching ? findInItems(items, q) : mergeOutline(items, outline)),
    [items, q, searching, outline],
  );
  const loaded = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  return (
    <Modal
      onClose={onClose}
      label="Find in session"
      align="sheet"
      panelClassName="w-full md:max-w-lg h-[80dvh] md:h-[70vh] flex flex-col rounded-t-2xl md:rounded-2xl border border-(--color-border) bg-(--color-panel) shadow-xl"
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 border-b border-(--color-border)">
        <Search size={16} className="text-(--color-faint) shrink-0" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find in this session…"
          enterKeyHint="search"
          className="flex-1 min-w-0 bg-transparent outline-none text-base md:text-sm placeholder:text-(--color-faint)"
        />
        <button onClick={onClose} className="p-2 -mr-1 rounded-lg text-(--color-dim) hover:text-white" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="px-3 py-1.5 text-tiny uppercase tracking-wide text-(--color-faint)">
        {searching ? `${hits.length}${hits.length >= 200 ? "+" : ""} match${hits.length === 1 ? "" : "es"}` : `Your prompts (${hits.length})`}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {hits.map((h) => (
          <button
            key={h.id}
            onClick={() => {
              if (loaded.has(h.id) || h.nodeId == null || !onJumpNode) onJump(h.id);
              else onJumpNode(h.nodeId);
              onClose();
            }}
            className="w-full flex items-start gap-2.5 text-left px-2 py-2.5 rounded-lg hover:bg-(--color-panel2) text-sm"
          >
            <span className="mt-0.5 text-(--color-dim) shrink-0">{ICON[h.kind]}</span>
            <span className="flex-1 min-w-0 text-(--color-text)">
              <Snippet hit={h} q={q.trim()} />
            </span>
            {typeof h.ts === "number" && (
              <span className="text-tiny text-(--color-faint) shrink-0 mt-0.5">{fmtMessageTime(h.ts)}</span>
            )}
          </button>
        ))}
        {!hits.length && (
          <p className="text-center text-sm text-(--color-faint) mt-8">
            {searching ? "No matches in the loaded messages." : "No prompts loaded yet."}
          </p>
        )}
        {canLoadOlder && (searching || !outline) && (
          <button
            onClick={onLoadOlder}
            disabled={loadingOlder}
            className="block mx-auto my-3 text-xs text-(--color-dim) hover:text-white px-3 py-2 rounded-full border border-(--color-border) disabled:opacity-50"
          >
            {loadingOlder ? "Loading…" : "Load earlier messages to search them"}
          </button>
        )}
      </div>
    </Modal>
  );
}
