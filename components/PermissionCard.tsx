"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, FileText, ShieldAlert, X } from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import type { PermissionOption, RequestPermissionRequest } from "@/lib/acp/types";
import { api, cancelRequest, respondRequest } from "@/lib/client/api";
import { useToast } from "./Toasts";
import Markdown from "./Markdown";
import ToolContent from "./ToolContent";
import Modal from "./Modal";

type ReqItem = Extract<ChatItem, { kind: "request" }>;

/** Pull the most telling fields out of a tool call's rawInput for preview. */
function previewOf(raw: unknown): { cmd?: string; path?: string } {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const str = (...ks: string[]) => {
    for (const k of ks) {
      const v = r[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  };
  return {
    cmd: str("command", "cmd", "cmdline", "query", "url"),
    path: str("path", "file_path", "filePath", "filename"),
  };
}

const isFormControl = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

/** Commands that destroy data or escalate privileges — the card warns in
 *  red so "Allow" is never a reflex click. */
const DESTRUCTIVE =
  /\brm\s+(-[^\s]*[rf][^\s]*\s+|\*|\.)|\bsudo\b|\bdd\b[^|\n]*\bof=|\bmkfs\b|\bgit\s+push\b[^|\n]*(--force|-f\b)|>\s*\/dev\/|\bchmod\s+(-R\s+)?777\b/;

/** session/request_permission — rendered as an inline approval card. */
export default function PermissionCard({ item, sessionId }: { item: ReqItem; sessionId: string }) {
  const params = item.params as unknown as RequestPermissionRequest;
  const options: PermissionOption[] = params.options ?? [];
  const tool = params.toolCall;
  const rootRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  // one response in flight — double-click/double-keypress must not send
  // a second answer to a request the server already settled
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => {
    setBusy(false);
    const msg = (e as Error).message;
    toast(/no such pending request/.test(msg) ? "This request is no longer pending." : `Response failed: ${msg}`);
  };

  const pick = (optionId: string) => {
    if (busy) return;
    setBusy(true);
    return respondRequest(sessionId, item.requestId, { outcome: { outcome: "selected", optionId } }).catch(fail);
  };
  const cancel = () => {
    if (busy) return;
    setBusy(true);
    return cancelRequest(sessionId, item.requestId).catch(fail);
  };

  // Y = allow once, Shift+A = allow always, N = reject (or cancel).
  // Only the first unresolved card answers, and only while focus is on the
  // page itself or inside this card — never while a form control, menu or
  // terminal has focus (a stray "a" must not grant permanent permission).
  useEffect(() => {
    if (item.resolved || busy) return;
    const h = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isFormControl(e.target)) return;
      if (document.querySelector("[data-perm-pending]") !== rootRef.current) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && !rootRef.current?.contains(focused)) return;
      const k = e.key.toLowerCase();
      const allowOnce = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow"));
      const allowAlways = options.find((o) => o.kind === "allow_always");
      const reject = options.find((o) => o.kind.startsWith("reject"));
      if (!e.shiftKey && k === "y" && allowOnce) void pick(allowOnce.optionId);
      else if (e.shiftKey && k === "a" && allowAlways) void pick(allowAlways.optionId);
      else if (!e.shiftKey && k === "n") {
        if (reject) void pick(reject.optionId);
        else void cancel();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.resolved, busy, sessionId, item.requestId, JSON.stringify(options)]);

  // allow_once is the recommended path → primary; allow_always persists so
  // it stays a secondary outline; rejects read red
  const kindStyle = (kind: string) =>
    kind === "allow_once"
      ? "bg-(--color-green) border-(--color-green) text-black font-semibold hover:brightness-110"
      : kind.startsWith("allow")
        ? "bg-transparent border-(--color-green)/50 text-(--color-green) hover:bg-(--color-green)/15"
        : kind.startsWith("reject")
          ? "bg-(--color-danger)/20 border-(--color-danger)/50 text-(--color-danger) hover:bg-(--color-danger)/30"
          : "bg-(--color-panel2) border-(--color-border) text-(--color-text) hover:border-(--color-accent)";

  const { cmd, path } = previewOf(tool?.rawInput);
  const destructive = !!cmd && DESTRUCTIVE.test(cmd);
  const diffs = (tool?.content ?? []).filter((c) => c.type === "diff");
  const kbdHint = (kind: string) =>
    kind === "allow_once" ? "Y" : kind === "allow_always" ? "⇧A" : kind.startsWith("reject") ? "N" : undefined;

  // exit_plan_mode asks permission to leave plan mode — its payload IS the
  // plan document (rawInput.plan markdown + cognition.ai/* _meta links), so
  // render the plan itself instead of the raw JSON dump
  const toolMeta =
    tool?._meta && typeof tool._meta === "object"
      ? (tool._meta as Record<string, unknown>)
      : {};
  const isExitPlan = toolMeta["cognition.ai/isExitPlan"] === true;
  const planFilePath =
    typeof toolMeta["cognition.ai/planFilePath"] === "string"
      ? (toolMeta["cognition.ai/planFilePath"] as string)
      : undefined;
  const cwd =
    typeof toolMeta["cognition.ai/cwd"] === "string" ? toolMeta["cognition.ai/cwd"] : undefined;
  const rawObj =
    tool?.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput)
      ? (tool.rawInput as Record<string, unknown>)
      : null;
  const planText =
    typeof rawObj?.plan === "string" ? rawObj.plan : undefined;
  const showPlan = isExitPlan || planText != null;

  const [planFile, setPlanFile] = useState<{ path: string; content: string } | null>(null);
  const openPlanFile = () => {
    if (!planFilePath) return;
    api<{ content?: unknown }>(`/api/fs/read?path=${encodeURIComponent(planFilePath)}`)
      .then((r) =>
        setPlanFile({
          path: planFilePath,
          content: typeof r.content === "string" ? r.content : "",
        }),
      )
      .catch((e) => toast(`Plan file failed: ${(e as Error).message}`));
  };
  // Esc closes the plan-file overlay (click-away and ✕ handled inline)
  useEffect(() => {
    if (!planFile) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlanFile(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [planFile]);

  return (
    <div
      ref={rootRef}
      {...(item.resolved ? {} : { "data-perm-pending": true })}
      className={`border rounded-xl px-3.5 py-3 ${
        item.resolved
          ? "border-(--color-border) opacity-50"
          : destructive
            ? "border-(--color-danger)/60 bg-(--color-danger)/5"
            : "border-(--color-warning)/60 bg-(--color-warning)/5"
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        {destructive ? (
          <AlertTriangle size={14} className="text-(--color-danger) shrink-0" />
        ) : (
          <ShieldAlert size={14} className="text-(--color-warning) shrink-0" />
        )}
        <span className="font-medium">Permission required</span>
        {destructive && (
          <span className="text-tiny uppercase tracking-wide px-1.5 py-0.5 rounded bg-(--color-danger)/20 text-(--color-danger) shrink-0">
            destructive
          </span>
        )}
        <span className="text-(--color-dim) truncate">{tool?.title ?? ""}</span>
      </div>
      {(cmd || path) && (
        <div className={`mono text-xs rounded p-2 mt-2 overflow-x-auto ${destructive ? "bg-(--color-danger)/10 border border-(--color-danger)/30" : "bg-(--color-code-bg)"}`}>
          {cmd && <div className="whitespace-pre-wrap">$ {cmd}</div>}
          {path && <div className="text-(--color-accent) truncate">{path}</div>}
          {cwd && <div className="text-(--color-faint) truncate mt-1">in {cwd}</div>}
        </div>
      )}
      {!item.resolved && diffs.length > 0 && (
        <div className="mt-2 max-h-72 overflow-y-auto flex flex-col gap-2">
          {diffs.map((c, i) => (
            <ToolContent key={i} c={c} />
          ))}
        </div>
      )}
      {showPlan && planText != null && (
        <div className="max-h-72 overflow-y-auto rounded bg-(--color-panel2) p-3 mt-2 text-sm">
          <Markdown>{planText}</Markdown>
        </div>
      )}
      {planFilePath && (
        <button
          onClick={openPlanFile}
          className="mt-2 flex items-center gap-1 text-xs text-(--color-accent) hover:underline"
        >
          <FileText size={12} />
          View plan file
        </button>
      )}
      {tool?.rawInput != null && !cmd && !path && !showPlan && (
        <pre className="mono text-xs bg-(--color-code-bg) rounded p-2 mt-2 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(tool.rawInput, null, 2).slice(0, 2000)}
        </pre>
      )}
      {!item.resolved && (
        <div className="flex flex-wrap gap-2 mt-2 items-center">
          {options.map((o) => {
            const hint = kbdHint(o.kind);
            return (
              <button
                key={o.optionId}
                onClick={() => void pick(o.optionId)}
                disabled={busy}
                className={`px-3 py-1.5 rounded border text-xs font-medium disabled:opacity-50 ${kindStyle(o.kind)}`}
              >
                {o.name}
                {hint && (
                  // touch devices have no keyboard — hide the shortcut hint
                  <kbd className="ml-1.5 px-1 rounded bg-(--color-code-bg) text-tiny opacity-70 pointer-coarse:hidden">{hint}</kbd>
                )}
              </button>
            );
          })}
          <button
            onClick={() => void cancel()}
            disabled={busy}
            className="px-3 py-1.5 rounded border border-(--color-border) text-xs text-(--color-dim) hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
      {!item.resolved && options.some((o) => o.kind === "allow_always") && (
        <div className="text-tiny text-(--color-faint) mt-1.5">
          “Always allow” auto-approves future calls of this kind{destructive ? " — including destructive commands" : ""}.
        </div>
      )}
      {item.resolved && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-(--color-dim)">
          <Check size={12} className="text-(--color-green) shrink-0" />
          {/* resolvedWith rides client_request_done — every tab shows the
              same outcome; older events without it fall back to Resolved */}
          <span>{item.resolvedWith ? `✓ ${item.resolvedWith}` : "Resolved"}</span>
        </div>
      )}
      {planFile && (
        <Modal onClose={() => setPlanFile(null)} label="Plan file"
          panelClassName="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-(--color-border) bg-(--color-panel) shadow-xl"
        >
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--color-border) shrink-0">
              <span className="text-sm font-medium truncate mono" title={planFile.path}>
                {planFile.path}
              </span>
              <button
                onClick={() => setPlanFile(null)}
                className="p-1 rounded text-(--color-dim) hover:text-white shrink-0"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 text-sm min-h-0">
              <Markdown>{planFile.content}</Markdown>
            </div>
        </Modal>
      )}
    </div>
  );
}
