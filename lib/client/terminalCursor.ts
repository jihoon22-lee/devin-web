export type TermAction =
  | { kind: "reset"; text: string }
  | { kind: "append"; text: string }
  | { kind: "skip" };

/** Decide what a terminal view does with one stream message. `cursor` is the
 *  absolute byte offset the view has written up to (server-provided — never
 *  computed from string length). */
export function planTerminalWrite(
  cursor: number,
  msg: Record<string, unknown>,
): { action: TermAction; cursor: number } {
  if (typeof msg.snapshot === "string") {
    const end = Number(msg.end);
    if (!Number.isFinite(end)) return { action: { kind: "skip" }, cursor };
    if (msg.partial === true) {
      // tail after a reconnect — the view keeps its scrollback
      if (end <= cursor) return { action: { kind: "skip" }, cursor };
      return { action: { kind: "append", text: msg.snapshot }, cursor: end };
    }
    return { action: { kind: "reset", text: msg.snapshot }, cursor: end };
  }
  if (typeof msg.data === "string") {
    const end = Number(msg.offset);
    if (!Number.isFinite(end) || end <= cursor) return { action: { kind: "skip" }, cursor };
    return { action: { kind: "append", text: msg.data }, cursor: end };
  }
  return { action: { kind: "skip" }, cursor };
}
