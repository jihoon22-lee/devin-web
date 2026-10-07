"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, FileDiff, FilePlus2, FileX2, GitCommitHorizontal, Loader2, MessageSquarePlus, Minus, Plus, RefreshCw, Send, Trash2, Undo2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { isImeComposing } from "@/lib/client/keys";
import { parseGitDiff } from "@/lib/client/diffParse";
import { annotateHunks, type DiffLine } from "@/lib/client/wordDiff";
import { reviewPrompt, useReviewComments, type ReviewComment } from "@/lib/client/review";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmDialog";

interface ChangedFile {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  M: { label: "M", cls: "text-(--color-warning)" },
  A: { label: "A", cls: "text-(--color-green)" },
  D: { label: "D", cls: "text-(--color-red)" },
  R: { label: "R", cls: "text-(--color-accent)" },
  "?": { label: "?", cls: "text-(--color-green)" },
  "??": { label: "?", cls: "text-(--color-green)" },
};

const LINE_CLS: Record<DiffLine["type"], string> = {
  add: "text-(--color-green) bg-(--color-green)/10",
  del: "text-(--color-red) bg-(--color-red)/10",
  hunk: "text-(--color-accent)",
  ctx: "text-(--color-dim)",
  meta: "text-(--color-dim)",
};

function LineBody({ l }: { l: DiffLine }) {
  if (!l.segs) return <>{l.raw || " "}</>;
  return (
    <>
      {l.raw[0]}
      {l.segs.map((sg, i) =>
        sg.changed ? (
          <span key={i} className={l.type === "add" ? "bg-(--color-green)/30 rounded-sm" : "bg-(--color-red)/30 rounded-sm"}>
            {sg.text}
          </span>
        ) : (
          sg.text
        ),
      )}
    </>
  );
}

function DiffView({
  patch,
  comments,
  onAddComment,
  onRemoveComment,
}: {
  patch: string;
  comments: ReviewComment[];
  onAddComment: (c: Omit<ReviewComment, "id">) => void;
  onRemoveComment: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  // parse + word-diff once per patch — the panel re-renders on every 5s
  // status poll, and the LCS pass is the expensive part on a phone
  const parsed = useMemo(
    () => parseGitDiff(patch).map((f) => ({ ...f, annotated: annotateHunks(f.lines) })),
    [patch],
  );
  /** `${fileIdx}:${lineIdx}` of the line whose comment box is open */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (!patch.trim()) {
    return <div className="text-(--color-dim) text-xs px-3 py-4 text-center">No textual changes (binary or unchanged file)</div>;
  }
  return (
    <div className="relative">
      <button
        onClick={() => {
          void navigator.clipboard.writeText(patch).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }).catch(() => {});
        }}
        className="absolute top-1.5 right-1.5 z-10 p-2 md:p-1 rounded bg-(--color-panel2) text-(--color-dim) hover:text-white"
        title="Copy diff"
        aria-label="Copy diff"
      >
        {copied ? <Check size={12} className="text-(--color-green)" /> : <Copy size={12} />}
      </button>
      {parsed.map((f, fi) => (
        <div key={fi}>
          {f.path && (
            <div className="flex items-center gap-1.5 px-2 py-1 border-b border-(--color-border) text-2xs text-(--color-dim)">
              {f.isNew ? (
                <FilePlus2 size={11} className="text-(--color-green) shrink-0" />
              ) : f.isDeleted ? (
                <FileX2 size={11} className="text-(--color-red) shrink-0" />
              ) : (
                <FileDiff size={11} className="text-(--color-faint) shrink-0" />
              )}
              <span className="mono truncate">{f.path}</span>
              {f.isNew && <span className="text-(--color-green) shrink-0">new file</span>}
              {f.isDeleted && <span className="text-(--color-red) shrink-0">deleted</span>}
            </div>
          )}
          <div className="mono text-2xs leading-relaxed overflow-x-auto py-2">
            {f.annotated.map((l, i) => {
              const key = `${fi}:${i}`;
              const line = l.newNo ?? l.oldNo;
              const commentable = f.path && (l.type === "add" || l.type === "del" || l.type === "ctx");
              const here = comments.filter((c) => c.file === f.path && c.line === line && c.side === l.type);
              return (
                <div key={i}>
                  <div
                    className={`group/ln flex min-w-max ${LINE_CLS[l.type]} ${commentable ? "cursor-pointer hover:brightness-125" : ""}`}
                    onClick={
                      commentable
                        ? () => {
                            setEditing(editing === key ? null : key);
                            setDraft("");
                          }
                        : undefined
                    }
                    title={commentable ? "Tap to comment on this line" : undefined}
                  >
                    <span className="w-4 shrink-0 text-center text-(--color-faint) opacity-0 group-hover/ln:opacity-100 [@media(pointer:coarse)]:hidden">
                      {commentable && <MessageSquarePlus size={10} className="inline" />}
                    </span>
                    <span className="whitespace-pre pr-3">
                      <LineBody l={l} />
                    </span>
                  </div>
                  {here.map((c) => (
                    <div key={c.id} className="flex items-start gap-2 mx-2 my-1 px-2 py-1.5 rounded-md border border-(--color-accent)/40 bg-(--color-panel) font-sans text-xs text-(--color-text) whitespace-pre-wrap">
                      <span className="flex-1 min-w-0">{c.body}</span>
                      <button
                        onClick={() => onRemoveComment(c.id)}
                        className="p-1 -m-1 text-(--color-faint) hover:text-(--color-danger)"
                        aria-label="Delete comment"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  {editing === key && (
                    <div className="mx-2 my-1 flex flex-col gap-1.5 font-sans" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        autoFocus
                        rows={2}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (isImeComposing(e)) return;
                          if (e.key === "Escape") setEditing(null);
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                            onAddComment({ file: f.path, line, side: l.type as ReviewComment["side"], code: l.raw.slice(1), body: draft.trim() });
                            setEditing(null);
                          }
                        }}
                        placeholder={`Comment on ${f.path.split("/").pop()}:${line ?? ""}…`}
                        className="w-full bg-(--color-panel2) border border-(--color-border) rounded-md px-2 py-1.5 text-base md:text-xs outline-none focus:border-(--color-accent)/60"
                      />
                      <div className="flex justify-end gap-1.5">
                        <button onClick={() => setEditing(null)} className="px-2.5 py-1.5 text-xs text-(--color-dim)">Cancel</button>
                        <button
                          disabled={!draft.trim()}
                          onClick={() => {
                            onAddComment({ file: f.path, line, side: l.type as ReviewComment["side"], code: l.raw.slice(1), body: draft.trim() });
                            setEditing(null);
                          }}
                          className="px-2.5 py-1.5 rounded-md bg-(--color-accent) text-black text-xs font-medium disabled:opacity-40"
                        >
                          Add comment
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Files changed in the session's working tree + per-file diff vs HEAD. */
export default function ChangesPanel({ sessionId, onOpenChat }: { sessionId: string; onOpenChat?: () => void }) {
  // Each session owns its rows, diff, undo token and pending requests. A
  // late response from the previous instance cannot enable actions here.
  return <SessionChanges key={sessionId} sessionId={sessionId} onOpenChat={onOpenChat} />;
}

function SessionChanges({ sessionId, onOpenChat }: { sessionId: string; onOpenChat?: () => void }) {
  const review = useReviewComments(sessionId);
  const toast = useToast();
  const confirm = useConfirm();
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [branch, setBranch] = useState("");
  const [notGit, setNotGit] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** last revert's backup — offered as "Undo revert" for 10 minutes */
  const [undo, setUndo] = useState<{ id: string; file: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10 * 60_000);
    return () => clearTimeout(t);
  }, [undo]);

  const load = useCallback(() => {
    api<{ files: ChangedFile[]; branch: string; notGit?: boolean; error?: string }>(
      `/api/sessions/${sessionId}/changes`,
    )
      .then((r) => {
        setFiles(r.files);
        setBranch(r.branch);
        setNotGit(!!r.notGit);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  }, [sessionId]);

  useEffect(() => {
    void load();
    // a backgrounded phone tab would otherwise keep forking 3 git processes
    // every 5s — pause while hidden, refresh once when the user comes back
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // closing or switching files drops the stale diff — adjusted during render
  // rather than in an effect so the loading state never flashes the old patch
  const [prevOpen, setPrevOpen] = useState<string | null>(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setPatch(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ patch: string }>(`/api/sessions/${sessionId}/changes?file=${encodeURIComponent(open)}`)
      .then((r) => !cancelled && setPatch(r.patch))
      .catch(() => !cancelled && setPatch(null));
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  const act = async (action: "stage" | "unstage" | "revert" | "commit" | "undo", file?: string) => {
    setBusy(`${action}:${file ?? ""}`);
    try {
      const res = await api<{ ok: boolean; undoId?: string }>(`/api/sessions/${sessionId}/changes`, {
        method: "POST",
        body: JSON.stringify(
          action === "commit"
            ? { action, message: commitMsg.trim() }
            : action === "undo"
              ? { action, undoId: undo?.id }
              : { action, file },
        ),
      });
      if (action === "commit") {
        setCommitMsg("");
        setCommitOpen(false);
        toast("Committed", "info");
      }
      if (action === "revert" && res.undoId && file) setUndo({ id: res.undoId, file });
      if (action === "undo") {
        setUndo(null);
        toast("Revert undone (worktree content restored)", "info");
      }
      load();
    } catch (e) {
      const body = e instanceof Error && "body" in e ? e.body : null;
      if (action === "revert" && file && body && typeof body === "object" &&
          "undoId" in body && typeof body.undoId === "string") {
        setUndo({ id: body.undoId, file });
      }
      load(); // git may have changed part of the worktree before failing
      toast(`${action} failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-(--color-border)">
        <span className="text-xs text-(--color-dim) flex-1 truncate">
          {branch ? `${branch} — working tree vs HEAD` : "working tree vs HEAD"}
        </span>
        {undo && (
          <button
            onClick={() => void act("undo")}
            className="text-2xs px-2 py-0.5 rounded border border-(--color-warning)/50 text-(--color-warning) hover:bg-(--color-warning)/10 truncate max-w-[45%]"
            title={`Restore ${undo.file} as it was before the revert (worktree content only)`}
          >
            Undo revert: {undo.file.split("/").pop()}
          </button>
        )}
        {(files?.length ?? 0) > 0 && (
          <button
            onClick={() => setCommitOpen((v) => !v)}
            className="p-1 rounded text-(--color-dim) hover:text-white"
            title="Commit staged changes"
            aria-label="Commit staged changes"
          >
            <GitCommitHorizontal size={14} />
          </button>
        )}
        <button onClick={load} className="p-1 rounded text-(--color-dim) hover:text-white" title="Refresh" aria-label="Refresh changes">
          <RefreshCw size={13} />
        </button>
      </div>
      {review.comments.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-(--color-accent)/30 bg-(--color-accent)/10">
          <span className="text-xs text-(--color-text) flex-1">
            {review.comments.length} review comment{review.comments.length > 1 ? "s" : ""}
          </span>
          <button
            onClick={review.clear}
            className="px-2 py-1.5 rounded text-xs text-(--color-dim) hover:text-white"
          >
            Clear
          </button>
          <button
            onClick={() => {
              // into the composer, not straight to the agent — the user
              // gets to read and edit the combined prompt first
              window.dispatchEvent(
                new CustomEvent("dw-restore", {
                  detail: { sessionId, blocks: [{ type: "text", text: reviewPrompt(review.comments) }] },
                }),
              );
              review.clear();
              onOpenChat?.();
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-(--color-accent) text-black text-xs font-medium"
          >
            <Send size={12} /> Send to agent
          </button>
        </div>
      )}
      {commitOpen && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-(--color-border)">
          <input
            autoFocus
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return; // Enter commits the Hangul syllable, not the form
              if (e.key === "Enter" && commitMsg.trim()) void act("commit");
              if (e.key === "Escape") setCommitOpen(false);
            }}
            placeholder="Commit message (staged files)…"
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-(--color-faint)"
          />
          <button
            onClick={() => void act("commit")}
            disabled={!commitMsg.trim() || busy === "commit:"}
            className="text-xs px-2 py-1 rounded bg-(--color-accent) text-black disabled:opacity-40"
          >
            Commit
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {err && <div className="text-(--color-red) text-sm px-3 py-2">{err}</div>}
        {notGit && <div className="text-(--color-dim) text-sm px-3 py-4 text-center">Not a git repository</div>}
        {files == null && !err && !notGit && (
          <Loader2 size={16} className="animate-spin text-(--color-dim) mx-auto mt-8" />
        )}
        {files?.length === 0 && !notGit && (
          <div className="text-(--color-dim) text-sm px-3 py-4 text-center">No uncommitted changes</div>
        )}
        {files?.map((f) => {
          // two-letter codes (e.g. "AM") fall back to their index-side letter
          const st = STATUS_STYLE[f.status] ?? STATUS_STYLE[f.status[0]] ?? STATUS_STYLE["M"];
          return (
            <div key={f.path}>
              <div className="group flex items-center hover:bg-(--color-panel2)">
                <button
                  onClick={() => setOpen(open === f.path ? null : f.path)}
                  aria-expanded={open === f.path}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 md:py-1.5 text-left"
                >
                  <span className={`w-4 shrink-0 text-2xs font-medium ${st.cls}`}>{st.label}</span>
                  <span className="mono text-xs flex-1 min-w-0 truncate" title={f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}>
                    {f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}
                  </span>
                  {f.staged && (
                    <span className="text-tiny px-1 rounded bg-(--color-green)/15 text-(--color-green) shrink-0">
                      staged
                    </span>
                  )}
                  {(f.additions > 0 || f.deletions > 0) && (
                    <span className="mono text-tiny shrink-0">
                      <span className="text-(--color-green)">+{f.additions}</span>
                      <span className="text-(--color-faint)">/</span>
                      <span className="text-(--color-red)">-{f.deletions}</span>
                    </span>
                  )}
                  <FileDiff size={12} className="text-(--color-faint) shrink-0" />
                </button>
                <span className="flex items-center pr-1.5 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  {f.unstaged && (
                    <button
                      onClick={() => void act("stage", f.path)}
                      disabled={busy === `stage:${f.path}`}
                      className="p-2 md:p-1 rounded text-(--color-dim) hover:text-(--color-green) disabled:opacity-40"
                      title="Stage file"
                      aria-label={`Stage ${f.path}`}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                  {f.staged && (
                    <button
                      onClick={() => void act("unstage", f.path)}
                      disabled={busy === `unstage:${f.path}`}
                      className="p-2 md:p-1 rounded text-(--color-dim) hover:text-(--color-warning) disabled:opacity-40"
                      title="Unstage file (keep worktree changes)"
                      aria-label={`Unstage ${f.path}`}
                    >
                      <Minus size={12} />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      void confirm({
                        title: `Discard changes in ${f.path}?`,
                        body: `${f.originalPath ? "Both paths of this rename will be restored. " : ""}You can undo this for 10 minutes (file content, links and permissions; staging is not restored).`,
                        confirmLabel: "Discard",
                        danger: true,
                      }).then((r) => {
                        if (r === "confirm") void act("revert", f.path);
                      });
                    }}
                    disabled={busy === `revert:${f.path}`}
                    className="p-2 md:p-1 rounded text-(--color-dim) hover:text-(--color-red) disabled:opacity-40"
                    title="Discard changes"
                    aria-label={`Discard changes in ${f.path}`}
                  >
                    <Undo2 size={12} />
                  </button>
                </span>
              </div>
              {open === f.path && (
                <div className="border-t border-b border-(--color-border) bg-(--color-code-bg)">
                  {patch == null ? (
                    <Loader2 size={13} className="animate-spin text-(--color-dim) m-3" />
                  ) : (
                    <DiffView
                      patch={patch}
                      comments={review.comments}
                      onAddComment={review.add}
                      onRemoveComment={review.remove}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
