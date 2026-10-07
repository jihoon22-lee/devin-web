"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, BookMarked, FileText, Folder, Image as ImageIcon, ListPlus, SendHorizontal, Slash, Square, X } from "lucide-react";
import type { SessionState } from "@/lib/client/model";
import type { ContentBlock } from "@/lib/acp/types";
import { blocksToDraft, mergeDraftText } from "@/lib/client/restore";
import { activeMentionQuery, relMentionPath } from "@/lib/mentions";
import { ensureNotifyPermission } from "@/lib/notify";
import { isImeComposing } from "@/lib/client/keys";
import { PROMPT_MAX_IMAGE_BYTES, PROMPT_MAX_TOTAL_BYTES } from "@/lib/limits";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmDialog";
import { api, cancelPrompt, sendPrompt } from "@/lib/client/api";
import ConfigBar from "./ConfigBar";
import { classifyConfig, optionSupportsImages, shortModelName } from "@/lib/client/configOptions";
import { useUiPrefs } from "@/lib/client/uiPrefs";

interface ImageAtt {
  data: string; // base64
  mimeType: string;
  preview: string;
}

interface FileCand {
  path: string;
  name: string;
  isDir: boolean;
}

/** Grow the composer with its content, capped at ~8 lines — `rows` can't
 *  see wrapped text, so measure scrollHeight directly. Below the cap the
 *  textarea never scrolls (overflow hidden); at the cap it scrolls. */
/** Attachments a composer held when its session was switched away — the
 *  composer is shared across sessions, and silently dropping a picked
 *  photo on a session hop is the phone failure mode. Tab-lifetime only
 *  (object URLs die with the page). */
const SNIP = "snip:";

const parkedAttachments = new Map<string, { images: ImageAtt[]; mentions: { path: string; name: string }[] }>();

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || 20;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const max = line * 8 + pad;
  const atMax = el.scrollHeight > max;
  el.style.height = `${Math.max(line + pad, Math.min(el.scrollHeight, max))}px`;
  el.style.overflowY = atMax ? "auto" : "hidden";
}

export default function ChatInput({
  sessionId,
  cwd,
  state,
}: {
  sessionId: string;
  cwd: string;
  state: SessionState;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAtt[]>([]);
  // latest attachments for callbacks that must not re-create per change
  // (addImage's total cap here, the unmount revoke in Round 8 C6)
  const imagesRef = useRef<ImageAtt[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  const [mentions, setMentions] = useState<{ path: string; name: string }[]>([]);
  const [palette, setPalette] = useState<"slash" | "mention" | null>(null);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [fileCands, setFileCands] = useState<FileCand[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftKey = `dw-draft-${sessionId}`;
  const { snippets } = useUiPrefs();
  const [dragging, setDragging] = useState(false);
  // live copies for the session-switch handoff below (effects see the
  // previous session's values only through refs)
  const textRef = useRef("");
  const mentionsRef = useRef<{ path: string; name: string }[]>([]);
  const prevSession = useRef<string | null>(null);
  useEffect(() => {
    textRef.current = text;
    mentionsRef.current = mentions;
  });
  // prompt history (↑ cycles); histIdx -1 = not navigating
  const [history, setHistory] = useState<string[]>([]);
  const histIdx = useRef(-1);
  const histDraft = useRef("");
  // touch devices have no Shift+Enter — Enter inserts a newline, send is the button
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setCoarse(matchMedia("(pointer: coarse)").matches));
  }, []);

  useEffect(() => {
    histIdx.current = -1;
    histDraft.current = "";
    api<{ prompts: string[] }>(`/api/sessions/${sessionId}/history`)
      .then((r) => setHistory(r.prompts))
      .catch(() => setHistory([]));
  }, [sessionId]);

  // per-session draft persistence. On a switch, the outgoing session's text
  // is written NOW (its debounced save was just cancelled) and its
  // attachments are parked; the incoming session gets back its own.
  useEffect(() => {
    const prev = prevSession.current;
    if (prev && prev !== sessionId) {
      try {
        const t = textRef.current;
        if (t) localStorage.setItem(`dw-draft-${prev}`, t);
        else localStorage.removeItem(`dw-draft-${prev}`);
      } catch {
        /* quota/ignore */
      }
      if (imagesRef.current.length || mentionsRef.current.length) {
        parkedAttachments.set(prev, { images: imagesRef.current, mentions: mentionsRef.current });
      } else parkedAttachments.delete(prev);
    }
    prevSession.current = sessionId;
    const parked = parkedAttachments.get(sessionId);
    parkedAttachments.delete(sessionId);
    queueMicrotask(() => {
      let stored = "";
      try {
        stored = localStorage.getItem(draftKey) ?? "";
      } catch {
        /* storage denied */
      }
      setText(stored);
      setImages(parked?.images ?? []);
      setMentions(parked?.mentions ?? []);
      setPalette(null);
    });
  }, [draftKey, sessionId]);

  // previews are object URLs — release them when the composer unmounts.
  // Read the ref: a state updater queued during unmount only runs if React
  // happens to evaluate it eagerly (not guaranteed). Parked attachments of
  // other sessions die with the composer too.
  useEffect(() => {
    const ref = imagesRef;
    return () => {
      for (const i of ref.current) URL.revokeObjectURL(i.preview);
      for (const p of parkedAttachments.values()) for (const i of p.images) URL.revokeObjectURL(i.preview);
      parkedAttachments.clear();
    };
  }, []);

  // "edit" on a queued prompt dispatches its original blocks — merge them into
  // the composer (never overwrite what the user is typing) and focus.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId?: string; blocks?: ContentBlock[] }>).detail;
      if (d?.sessionId !== sessionId || !Array.isArray(d.blocks)) return;
      const parts = blocksToDraft(d.blocks);
      setText((t) => mergeDraftText(t, parts.text));
      setImages((v) => [...v, ...parts.images]);
      setMentions((v) => [...v, ...parts.mentions]);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    };
    window.addEventListener("dw-restore", h);
    return () => window.removeEventListener("dw-restore", h);
  }, [sessionId]);

  // file-explorer "@" button → append an @mention token + register the mention
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId: string; path: string }>).detail;
      if (d?.sessionId !== sessionId || !d.path) return;
      const rel = relMentionPath(cwd, d.path);
      setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${rel} `);
      setMentions((v) => (v.some((m) => m.path === d.path) ? v : [...v, { path: d.path, name: d.path.split("/").pop() ?? d.path }]));
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    };
    window.addEventListener("dw-mention", h);
    return () => window.removeEventListener("dw-mention", h);
  }, [sessionId, cwd]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (text) localStorage.setItem(draftKey, text);
        else localStorage.removeItem(draftKey);
      } catch {
        /* quota/ignore */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [text, draftKey]);

  // re-fit the textarea after every text mutation — typing, paste, history
  // nav, mention/restore inserts, draft hydration and the post-send reset
  // all funnel through `text`
  useEffect(() => {
    const el = taRef.current;
    if (el) autosize(el);
  }, [text]);

  const busy = state.running;
  const canSend = text.trim().length > 0 || images.length > 0;

  // current model's image support — drives the attach toast + the amber note
  const modelCfg = classifyConfig(state.configOptions).model;
  const modelName = modelCfg ? shortModelName(modelCfg, String(modelCfg.currentValue ?? "")) : "";
  const modelSupportsImages = modelCfg
    ? optionSupportsImages(modelCfg, String(modelCfg.currentValue ?? ""))
    : undefined;

  // caret position → which palette to show. Render can't read the DOM ref, so
  // the caret is tracked in state via onSelect/onChange; event handlers that
  // need the live position pass ta.selectionStart directly.
  const [caretPos, setCaretPos] = useState(0);
  const caretQuery = (caret: number): { kind: "slash" | "mention"; q: string; start: number } | null => {
    const before = text.slice(0, caret);
    const sm = /(?:^|\s)\/([^\s/]*)$/.exec(before);
    if (sm) return { kind: "slash", q: sm[1], start: caret - sm[1].length };
    const mm = activeMentionQuery(text, caret);
    if (mm) return { kind: "mention", q: mm.q, start: mm.start };
    return null;
  };

  const active = palette ? caretQuery(caretPos) : null;

  // fetch file completions for @ palette (debounced); a slower response for
  // an older query must not overwrite the newer one
  const mentionQ = active?.kind === "mention" ? active.q : null;
  const candSeq = useRef(0);
  useEffect(() => {
    if (mentionQ === null || !cwd) return;
    const seq = ++candSeq.current;
    const t = setTimeout(() => {
      api<{ files: FileCand[] }>(`/api/fs/complete?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(mentionQ)}`)
        .then((r) => { if (seq === candSeq.current) setFileCands(r.files); })
        .catch(() => { if (seq === candSeq.current) setFileCands([]); });
    }, 120);
    return () => clearTimeout(t);
  }, [mentionQ, cwd]);

  const slashCommands = (state.commands ?? []).filter((c) =>
    active?.kind === "slash" ? c.name.toLowerCase().startsWith(active.q.toLowerCase()) : false,
  );

  const snippetHits =
    active?.kind === "slash"
      ? snippets.filter((sn) => sn.name.toLowerCase().includes(active.q.toLowerCase()))
      : [];

  const paletteItems: { key: string; label: string; desc?: string; icon: React.ReactNode }[] =
    active?.kind === "slash"
      ? [
          // user snippets first — they're what a phone user reaches for
          ...snippetHits.slice(0, 20).map((sn) => ({
            key: `${SNIP}${sn.id}`,
            label: `/${sn.name}`,
            desc: sn.text.replace(/\s+/g, " ").slice(0, 80),
            icon: <BookMarked size={12} />,
          })),
          ...slashCommands.slice(0, 20).map((c) => ({
            key: c.name,
            label: `/${c.name}`,
            desc: c.description,
            icon: <Slash size={12} />,
          })),
        ]
      : active?.kind === "mention"
        ? fileCands.map((f) => ({
            key: f.path,
            label: f.path,
            desc: f.isDir ? "dir" : undefined,
            icon: f.isDir ? <Folder size={12} /> : <FileText size={12} />,
          }))
        : [];

  // items can shrink without a keystroke (async file completions arrive) —
  // never let the highlight/pick index run past the end
  const selIdx = Math.min(paletteIdx, Math.max(0, paletteItems.length - 1));

  const pick = (key: string) => {
    const q = caretQuery(taRef.current?.selectionStart ?? text.length);
    if (!q || !taRef.current) return;
    const before = text.slice(0, q.start - 1); // drop the trigger char position base
    const after = text.slice(taRef.current.selectionStart ?? text.length);
    if (q.kind === "slash" && key.startsWith(SNIP)) {
      // a snippet replaces its /trigger with the stored prompt text
      const sn = snippets.find((x) => `${SNIP}${x.id}` === key);
      const body = sn?.text ?? "";
      setText(`${before}${body}${after.startsWith(" ") || !after ? "" : " "}${after}`);
      setPalette(null);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = before.length + body.length;
      });
      return;
    }
    if (q.kind === "slash") {
      setText(`${before}/${key} ${after}`);
    } else {
      setText(`${before}@${key} ${after}`);
      setMentions((v) => [...v, { path: `${cwd.replace(/\/$/, "")}/${key}`, name: key.split("/").pop() ?? key }]);
    }
    setPalette(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const send = useCallback(async () => {
    if (!canSend) return;
    ensureNotifyPermission(); // user gesture — safe place to ask once
    const t = text;
    const prevImages = images;
    const prevMentions = mentions;
    const imgs = images.map((i) => ({ data: i.data, mimeType: i.mimeType }));
    // keep only mentions whose token still exists in the text
    const kept = mentions.filter((m) => {
      const rel = relMentionPath(cwd, m.path);
      return t.includes(`@${rel}`);
    });
    setText("");
    setImages([]);
    setMentions([]);
    setPalette(null);
    histIdx.current = -1;
    try {
      await sendPrompt(sessionId, t, imgs.length ? imgs : undefined, kept.length ? kept : undefined);
      setHistory((h) => [t, ...h]);
      for (const i of prevImages) URL.revokeObjectURL(i.preview);
    } catch (e) {
      // restore everything the user composed, and say why it failed
      setText(t);
      setImages(prevImages);
      setMentions(prevMentions);
      toast(`Send failed: ${(e as Error).message}`);
    }
  }, [text, images, mentions, canSend, sessionId, cwd, toast]);

  const addImage = useCallback(async (f: File) => {
    // mirror the server caps (lib/limits.ts) — fail early with a toast
    if (f.size > PROMPT_MAX_IMAGE_BYTES) {
      toast(`${f.name || "image"} exceeds ${PROMPT_MAX_IMAGE_BYTES / 1048576}MB`);
      return;
    }
    const attached = imagesRef.current.reduce((n, i) => n + Math.floor(i.data.length * 0.75), 0);
    if (attached + f.size > PROMPT_MAX_TOTAL_BYTES) {
      toast(`attachments would exceed ${PROMPT_MAX_TOTAL_BYTES / 1048576}MB in total`);
      return;
    }
    // FileReader.readAsDataURL avoids the spread-based fromCharCode which
    // overflows the call stack on large images (RangeError at ~65k+ args).
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
    setImages((v) => [
      ...v,
      { data: b64, mimeType: f.type || "image/png", preview: URL.createObjectURL(f) },
    ]);
    if (modelSupportsImages === false) {
      toast(`${modelName || "This model"} may not support image input`);
    }
  }, [toast, modelSupportsImages, modelName]);

  // paste images
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      for (const item of e.clipboardData?.items ?? []) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) void addImage(f);
          e.preventDefault();
        }
      }
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [addImage]);

  // Stop cancels the running turn; with prompts waiting, ask whether they
  // should be dropped too (otherwise the next one starts immediately)
  const stop = async () => {
    let clearQueue = false;
    if (state.queued > 0) {
      const r = await confirm({
        title: "Stop this turn?",
        body: `${state.queued} queued prompt(s) are parked behind it.`,
        confirmLabel: "Stop only",
        altLabel: `Stop & drop ${state.queued} queued`,
      });
      if (r === null) return;
      clearQueue = r === "alt";
    }
    void cancelPrompt(sessionId, clearQueue).catch((e) =>
      toast(`Stop failed: ${(e as Error).message}`),
    );
  };

  const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

  return (
    <div
      className={`relative border-t border-(--color-border) bg-(--color-panel) px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] ${
        dragging ? "ring-2 ring-inset ring-(--color-accent)/60" : ""
      }`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        const files = [...e.dataTransfer.files];
        const imgs = files.filter((f) => f.type.startsWith("image/"));
        for (const f of imgs) void addImage(f);
        if (imgs.length < files.length) toast("Only images can be attached — use @ to mention other files");
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-(--color-panel)/85 text-sm text-(--color-accent)">
          Drop images to attach
        </div>
      )}
      {/* config chips: mode / model / thinking / extras (ConfigBar owns
          pending state and the Shift+Tab / ⌘. window events) */}
      <ConfigBar sessionId={sessionId} state={state} />

      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.preview} alt="" className="h-14 rounded border border-(--color-border)" />
              <button
                onClick={() =>
                  setImages((v) => v.filter((im, j) => {
                    if (j === i) URL.revokeObjectURL(im.preview);
                    return j !== i;
                  }))
                }
                aria-label="Remove attachment"
                title="Remove attachment"
                className="absolute -top-2 -right-2 bg-(--color-panel2) border border-(--color-border) rounded-full p-1 md:p-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && modelSupportsImages === false && (
        <div className="text-(--color-warning) text-xs mb-2">
          {modelName || "This model"} may not support image input
        </div>
      )}

      <div className="relative">
        {palette && paletteItems.length > 0 && (
          <div className="absolute bottom-full mb-1 left-0 w-full max-w-md max-h-60 overflow-y-auto bg-(--color-panel2) border border-(--color-border) rounded-lg shadow-xl z-20">
            {paletteItems.map((it, i) => (
              <button
                key={it.key}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pick(it.key);
                }}
                className={`w-full text-left px-3 py-2 text-sm flex gap-2 items-baseline ${
                  i === selIdx ? "bg-(--color-panel)" : "hover:bg-(--color-panel)"
                }`}
              >
                <span className="text-(--color-dim) shrink-0">{it.icon}</span>
                <span className={`mono ${active?.kind === "slash" ? "text-(--color-accent)" : "text-(--color-text)"} truncate`}>
                  {it.label}
                </span>
                {it.desc && <span className="text-(--color-dim) text-xs truncate">{it.desc}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="p-2 md:p-2.5 text-(--color-dim) hover:text-white"
            title="Attach image"
            aria-label="Attach image"
          >
            <ImageIcon size={17} />
          </button>
          <button
            onClick={() => {
              setText((t) => t + "@");
              setPalette("mention");
              requestAnimationFrame(() => {
                const ta = taRef.current;
                if (ta) {
                  ta.focus();
                  ta.selectionStart = ta.selectionEnd = ta.value.length;
                }
              });
            }}
            className="p-2 md:p-2.5 text-(--color-dim) hover:text-white"
            title="Mention a file (@)"
            aria-label="Mention a file"
          >
            <AtSign size={17} />
          </button>
          <button
            onClick={() => {
              setText((t) => (t && !/\s$/.test(t) ? `${t} /` : `${t}/`));
              setPalette("slash");
              requestAnimationFrame(() => {
                const ta = taRef.current;
                if (ta) {
                  ta.focus();
                  ta.selectionStart = ta.selectionEnd = ta.value.length;
                  setCaretPos(ta.value.length);
                }
              });
            }}
            className="p-2 md:p-2.5 text-(--color-dim) hover:text-white"
            title="Commands & snippets (/)"
            aria-label="Commands and snippets"
          >
            <Slash size={17} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              for (const f of e.target.files ?? []) void addImage(f);
              e.target.value = "";
            }}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaretPos(e.target.selectionStart);
              histIdx.current = -1; // typing cancels history navigation
              requestAnimationFrame(() => {
                const q = caretQuery(taRef.current?.selectionStart ?? e.target.value.length);
                setPalette(q ? q.kind : null);
                setPaletteIdx(0);
              });
            }}
            onSelect={(e) => setCaretPos(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return; // Enter/arrows belong to the IME while composing
              if (palette && paletteItems.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIdx((i) => (i + 1) % paletteItems.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIdx((i) => (i - 1 + paletteItems.length) % paletteItems.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(paletteItems[selIdx].key); return; }
                if (e.key === "Escape") { setPalette(null); return; }
              }
              // ⇧Tab cycles the session mode (skipping Bypass) — ConfigBar
              // owns the pending-aware set, so this just pings it.
              if (e.key === "Tab" && e.shiftKey) {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent("dw-cycle-mode"));
                return;
              }
              // ↑/↓ prompt history: ↑ works when caret is at the very start
              // (or already cycling), ↓ walks back to the saved draft.
              if (history.length > 0 && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                const ta = taRef.current;
                const caretAtStart = !ta || ta.selectionStart === 0;
                if (e.key === "ArrowUp" && (histIdx.current >= 0 || caretAtStart)) {
                  e.preventDefault();
                  if (histIdx.current === -1) histDraft.current = text;
                  histIdx.current = Math.min(histIdx.current + 1, history.length - 1);
                  setText(history[histIdx.current]);
                  setPalette(null);
                  return;
                }
                if (e.key === "ArrowDown" && histIdx.current >= 0) {
                  e.preventDefault();
                  histIdx.current -= 1;
                  setText(histIdx.current === -1 ? histDraft.current : history[histIdx.current]);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !coarse) {
                e.preventDefault();
                void send();
              }
            }}
            onClick={() => {
              const q = caretQuery(taRef.current?.selectionStart ?? text.length);
              setPalette(q ? q.kind : null);
            }}
            placeholder={busy ? "Queue a message…" : "Message Devin… (/ commands, @ files)"}
            rows={1}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint={coarse ? "enter" : "send"}
            className="flex-1 bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-base outline-none focus:border-(--color-accent) resize-none overflow-y-hidden"
          />
          {busy && (
            <button
              onClick={stop}
              className="p-3 rounded-lg bg-(--color-red)/20 border border-(--color-red)/50 text-(--color-red) hover:bg-(--color-red)/30"
              title="Stop"
              aria-label="Stop"
            >
              <Square size={15} />
            </button>
          )}
          {/* stays available while running — touch keyboards have no
              Shift+Enter, so this is the only way to queue on mobile */}
          <button
            onClick={() => void send()}
            disabled={!canSend}
            className="p-3 rounded-lg bg-(--color-accent) text-black disabled:opacity-30 hover:brightness-110"
            title={busy ? "Queue message" : "Send"}
            aria-label={busy ? "Queue message" : "Send"}
          >
            {busy ? <ListPlus size={15} /> : <SendHorizontal size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
