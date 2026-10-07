"use client";

import { useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { foldContext, lineDiff } from "@/lib/diff";
import type { ToolCallContent } from "@/lib/acp/types";

/** Tool text payloads are unbounded — a single read can hand back megabytes
 *  and freeze a mobile tab. Render a bounded slice with an explicit
 *  expander so truncation is visible, not silent. */
const TEXT_CAP = 200_000;

function BoundedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const cls = "mono text-xs bg-(--color-code-bg) rounded p-2 overflow-x-auto whitespace-pre-wrap";
  if (text.length <= TEXT_CAP || expanded) {
    return <pre className={cls}>{text}</pre>;
  }
  return (
    <div>
      <pre className={cls}>{text.slice(0, TEXT_CAP)}</pre>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1 text-2xs text-(--color-accent) hover:underline"
      >
        show all — {Math.round((text.length - TEXT_CAP) / 1024)}KB truncated
      </button>
    </div>
  );
}

/** One ToolCallContent entry — diff, text/resource, image or terminal ref.
 *  Shared by tool cards and permission cards. */
export default function ToolContent({ c }: { c: ToolCallContent }) {
  const diffRows = useMemo(
    () => (c.type === "diff" ? foldContext(lineDiff(c.oldText, c.newText), 3) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c.type === "diff" ? c.oldText : null, c.type === "diff" ? c.newText : null],
  );
  if (c.type === "diff" && diffRows) {
    return (
      <div className="mono text-xs rounded bg-(--color-code-bg) overflow-x-auto">
        <div className="text-(--color-dim) px-2 py-1.5 border-b border-(--color-border)">{c.path}</div>
        <div className="p-1.5">
          {diffRows.map((r, i) =>
            r.type === "fold" ? (
              <div key={i} className="text-(--color-faint) text-center text-tiny py-0.5 select-none">
                ··· {r.folded} unchanged ···
              </div>
            ) : (
              <div
                key={i}
                className={`px-1 whitespace-pre rounded-sm ${
                  r.type === "add"
                    ? "text-(--color-green) bg-(--color-green)/10"
                    : r.type === "del"
                      ? "text-(--color-red) bg-(--color-red)/10 line-through decoration-(--color-red)/40"
                      : "text-(--color-dim)"
                }`}
              >
                <span className="inline-block w-3 select-none opacity-60">
                  {r.type === "add" ? "+" : r.type === "del" ? "-" : " "}
                </span>
                {r.text}
              </div>
            ),
          )}
        </div>
      </div>
    );
  }
  if (c.type === "content") {
    const inner = c.content;
    if (inner.type === "text") {
      return <BoundedText text={inner.text} />;
    }
    if (inner.type === "resource" && inner.resource.text) {
      return <BoundedText text={inner.resource.text} />;
    }
    if (inner.type === "resource_link") {
      return <div className="mono text-xs text-(--color-accent)">{inner.uri}</div>;
    }
    if (inner.type === "image") {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={`data:${inner.mimeType};base64,${inner.data}`} alt="" className="max-w-xs rounded" />;
    }
  }
  if (c.type === "terminal") {
    return (
      <div className="mono text-xs text-(--color-dim) flex items-center gap-1">
        <Terminal size={11} /> terminal: {c.terminalId}
      </div>
    );
  }
  return null;
}
