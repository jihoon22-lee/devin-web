"use client";

import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";
import type { ChatItem } from "@/lib/client/model";

/** Tab-title notification when a turn finishes while the tab is hidden —
 *  the ref is scoped by sessionId so switching away from a running session
 *  can't make the next (idle) session report a phantom completion. */
export function useTurnTitleNotify(sessionId: string, running: boolean, title: string) {
  const prevRunning = useRef({ sid: "", running: false });
  useEffect(() => {
    const was = prevRunning.current.sid === sessionId && prevRunning.current.running;
    prevRunning.current = { sid: sessionId, running };
    if (was && !running && document.hidden) {
      document.title = `● ${title || sessionId} — devin-web`;
      notify(title || sessionId, "Turn complete", `?s=${encodeURIComponent(sessionId)}`);
      const restore = () => {
        document.title = "devin-web";
      };
      const onVis = () => {
        if (!document.hidden) restore();
      };
      window.addEventListener("focus", restore, { once: true });
      document.addEventListener("visibilitychange", onVis);
      return () => {
        window.removeEventListener("focus", restore);
        document.removeEventListener("visibilitychange", onVis);
        restore();
      };
    }
  }, [running, title, sessionId]);
}

/** The visible-tab counterpart: a quiet summary toast instead of the
 *  title ping (kept separate so `items` churn can't cut the hidden-path
 *  listeners/title restore short). */
export function useTurnDoneToast(
  sessionId: string,
  running: boolean,
  runningSince: number | null | undefined,
  items: ChatItem[],
  toast: (text: string, kind?: "info" | "error") => void,
) {
  const prevRunningVis = useRef({ sid: "", running: false });
  useEffect(() => {
    const was = prevRunningVis.current.sid === sessionId && prevRunningVis.current.running;
    prevRunningVis.current = { sid: sessionId, running };
    if (!was || running || document.hidden) return;
    const secs = runningSince
      ? Math.max(0, Math.floor((Date.now() - runningSince) / 1000))
      : 0;
    const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    // the just-finished turn's tool count — tool items after the last
    // user bubble
    let tools = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "text" && it.role === "user") break;
      if (it.kind === "tool") tools++;
    }
    toast(`Done · ${dur} · ${tools} tool call${tools === 1 ? "" : "s"}`, "info");
  }, [running, runningSince, items, toast, sessionId]);
}

/** System notification when Devin asks for input while the tab is hidden —
 *  the seen set is per session so it can't grow across switches. */
export function useRequestNotify(sessionId: string, title: string, items: ChatItem[]) {
  const notifiedReqs = useRef({ sid: "", ids: new Set<string>() });
  useEffect(() => {
    if (notifiedReqs.current.sid !== sessionId)
      notifiedReqs.current = { sid: sessionId, ids: new Set() };
    for (const it of items) {
      if (it.kind === "request" && !it.resolved && !notifiedReqs.current.ids.has(it.requestId)) {
        notifiedReqs.current.ids.add(it.requestId);
        notify(
          title || sessionId,
          it.method === "session/request_permission" ? "Permission required" : "Input required",
          `?s=${encodeURIComponent(sessionId)}`,
        );
      }
    }
  }, [items, title, sessionId]);
}
