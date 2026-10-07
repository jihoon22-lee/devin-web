"use client";

import { useCallback, useEffect, useState } from "react";

/** A comment on one diff line in the Changes tab. */
export interface ReviewComment {
  id: string;
  file: string;
  /** new-file line for added/context lines, old-file line for removals */
  line?: number;
  side: "add" | "del" | "ctx";
  /** the line's content (no +/- prefix) — anchors the comment for the agent */
  code: string;
  body: string;
}

const key = (sid: string) => `dw-review:${sid}`;

function load(sid: string): ReviewComment[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(sid)) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as ReviewComment[]) : [];
  } catch {
    return [];
  }
}

/** Per-session review comments, kept in localStorage: on a phone the
 *  Changes panel unmounts every time the user flips back to the chat. */
export function useReviewComments(sessionId: string) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  useEffect(() => {
    queueMicrotask(() => setComments(load(sessionId)));
  }, [sessionId]);
  const persist = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      try {
        if (next.length) localStorage.setItem(key(sessionId), JSON.stringify(next));
        else localStorage.removeItem(key(sessionId));
      } catch {
        /* this view only */
      }
    },
    [sessionId],
  );
  return {
    comments,
    add: (c: Omit<ReviewComment, "id">) =>
      persist([...load(sessionId), { ...c, id: Math.random().toString(36).slice(2, 10) }]),
    remove: (id: string) => persist(load(sessionId).filter((c) => c.id !== id)),
    clear: () => persist([]),
  };
}

/** One prompt carrying every comment, grouped by file in line order. */
export function reviewPrompt(comments: ReviewComment[]): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const parts = ["Please address these review comments on the current working-tree changes:"];
  for (const [file, list] of byFile) {
    list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    for (const c of list) {
      const where = `${file}${c.line != null ? `:${c.line}` : ""}${c.side === "del" ? " (removed line)" : ""}`;
      const code = c.code.trim();
      parts.push(`\n- ${where}${code ? ` — \`${code.slice(0, 160)}\`` : ""}\n  ${c.body.replace(/\n/g, "\n  ")}`);
    }
  }
  return parts.join("\n");
}
