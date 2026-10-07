/** Pure helpers for turning sessions.db message_nodes rows into a display transcript. */

export interface MessageNodeRow {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number | null;
}

export interface TranscriptItem {
  /** message_nodes.node_id — monotonically increasing per session, for incremental fetch */
  id?: number;
  /** chat_message.message_id — streaming snapshots share this; clients merge by it */
  messageId?: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  ts: number | null;
  toolName?: string;
  /** links to tool_call_state.tool_call_id — present on role=tool rows */
  toolCallId?: string;
  /** merged ToolCall+ToolCallUpdate from tool_call_state, attached by the route */
  tool?: unknown;
}

interface ChatMessage {
  message_id?: string;
  role?: string;
  content?: string | { type?: string; text?: string }[];
  metadata?: { tool_name?: string; name?: string; is_user_input?: unknown } | null;
  tool_call_id?: string;
}

/** The CLI tags genuine user input metadata.is_user_input=1; internal
 *  user-role nodes (compaction/summary payloads carrying the whole
 *  conversation) have the key present but falsy. Those must not render as
 *  user bubbles — a key that is ABSENT entirely (older writers) still
 *  counts as user input so old transcripts don't lose messages. */
function isInternalUserNode(msg: ChatMessage): boolean {
  return (
    msg.role === "user" &&
    msg.metadata != null &&
    "is_user_input" in msg.metadata &&
    !msg.metadata.is_user_input
  );
}

function contentText(c: ChatMessage["content"]): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type ?? "block"}]`))
      .join("\n");
  }
  return "";
}

/** Extract plain text from a raw message_nodes.chat_message JSON blob. */
export function messageText(chatMessage: string): string {
  try {
    return contentText((JSON.parse(chatMessage) as ChatMessage).content);
  } catch {
    return "";
  }
}

/** Single parse for indexers that need both the extracted text and the role
 *  (search filtering skips tool output unless asked for it). */
export function messageMeta(chatMessage: string): { text: string; role: string } {
  try {
    const msg = JSON.parse(chatMessage) as ChatMessage;
    return { text: contentText(msg.content), role: msg.role ?? "" };
  } catch {
    return { text: "", role: "" };
  }
}

/** Walk the parent chain back from the newest node so forks show the main branch only. */
export function orderMainChain(rows: MessageNodeRow[]): MessageNodeRow[] {
  if (!rows.length) return [];
  const byId = new Map(rows.map((r) => [r.node_id, r]));
  let cur = rows.reduce((a, b) => (b.node_id > a.node_id ? b : a));
  const chain: MessageNodeRow[] = [];
  const seen = new Set<number>();
  while (cur && !seen.has(cur.node_id)) {
    seen.add(cur.node_id);
    chain.push(cur);
    cur = cur.parent_node_id != null ? byId.get(cur.parent_node_id)! : (undefined as never);
  }
  return chain.reverse();
}

export function rowsToTranscript(rows: MessageNodeRow[], max = 1000): { items: TranscriptItem[]; truncated: boolean } {
  const chain = orderMainChain(rows);
  const items: TranscriptItem[] = [];
  for (const r of chain) {
    let msg: ChatMessage;
    try {
      msg = JSON.parse(r.chat_message);
    } catch {
      continue;
    }
    const role = msg.role ?? "";
    if (role === "system") continue;
    if (isInternalUserNode(msg)) continue;
    const text = contentText(msg.content);
    if (!text.trim()) continue;
    const mapped: TranscriptItem["role"] =
      role === "user" ? "user" : role === "assistant" ? "assistant" : role === "tool" ? "tool" : "system";
    if (mapped === "system") continue;
    items.push({
      id: Number(r.node_id),
      messageId: msg.message_id,
      role: mapped,
      text,
      ts: r.created_at,
      toolName: msg.metadata?.tool_name ?? msg.metadata?.name,
      toolCallId: msg.tool_call_id,
    });
  }
  const truncated = items.length > max;
  return { items: truncated ? items.slice(-max) : items, truncated };
}

/** Map a single message_nodes row to a TranscriptItem (no chain ordering —
 *  used for incremental "rows after X" pushes where order = node_id). */
export function rowToItem(r: MessageNodeRow): TranscriptItem | null {
  let msg: ChatMessage;
  try {
    msg = JSON.parse(r.chat_message);
  } catch {
    return null;
  }
  const role = msg.role ?? "";
  if (role === "system") return null;
  if (isInternalUserNode(msg)) return null;
  const text = contentText(msg.content);
  if (!text.trim()) return null;
  const mapped: TranscriptItem["role"] =
    role === "user" ? "user" : role === "assistant" ? "assistant" : role === "tool" ? "tool" : "system";
  if (mapped === "system") return null;
  return {
    id: Number(r.node_id),
    messageId: msg.message_id,
    role: mapped,
    text,
    ts: r.created_at,
    toolName: msg.metadata?.tool_name ?? msg.metadata?.name,
    toolCallId: msg.tool_call_id,
  };
}

export interface TranscriptDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

/** Join tool_call_state into tool items so read-only transcripts can render
 *  the same tool cards (diffs, status, terminal previews) as live sessions.
 *  tool_call_json = initial ToolCall (title/kind/rawInput);
 *  tool_call_update_json = final update (status/content) — merge update over call. */
export function attachToolState(db: TranscriptDb, sessionId: string, items: TranscriptItem[]) {
  const ids = [...new Set(items.map((i) => i.toolCallId).filter(Boolean))] as string[];
  if (!ids.length) return;
  try {
    const rows = db
      .prepare(
        `SELECT tool_call_id, tool_call_json, tool_call_update_json
         FROM tool_call_state WHERE session_id = ? AND tool_call_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(sessionId, ...ids) as {
      tool_call_id: string;
      tool_call_json: string | null;
      tool_call_update_json: string | null;
    }[];
    const byId = new Map<string, unknown>();
    for (const r of rows) {
      if ((r.tool_call_json?.length ?? 0) + (r.tool_call_update_json?.length ?? 0) > 512 * 1024)
        continue; // absurdly large payload — fall back to plain text rendering
      const call = r.tool_call_json ? (JSON.parse(r.tool_call_json) as object) : {};
      const upd = r.tool_call_update_json ? (JSON.parse(r.tool_call_update_json) as object) : {};
      byId.set(r.tool_call_id, { ...call, ...upd });
    }
    for (const i of items) {
      const t = i.toolCallId ? byId.get(i.toolCallId) : undefined;
      if (t) i.tool = t;
    }
  } catch {
    /* table absent or parse error — plain text items still render */
  }
}
