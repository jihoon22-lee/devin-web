"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDurableDelta, applyViewFrame, emptySessionState, prependTranscript,
  type SessionState,
} from "@/lib/client/model";
import type { TranscriptItem } from "@/lib/transcript";
import type { ViewFrame } from "@/lib/acp/sessionView";
import { integrityBeacon } from "@/lib/client/integrity";
import { diag, onServerRestart, onStreamState, resubscribe, streamSub } from "@/lib/client/stream";
import { api } from "@/lib/client/api";

/** One authoritative snapshot followed by contiguous view patches. Durable
 *  deltas use the transcript sub; pagination only extends the durable region. */
export function useSessionView(sessionId: string | null) {
  const [box, setBox] = useState<{ sid: string | null; state: SessionState }>({
    sid: null, state: emptySessionState(),
  });
  const [connected, setConnected] = useState(false);
  const stateRef = useRef<SessionState>(emptySessionState());
  const lastIntegrity = useRef("");
  const lifecycle = useRef<{ sid: string | null; cancelled: boolean; generation: number } | null>(null);

  const push = useCallback(() => {
    setBox({ sid: sessionId, state: { ...stateRef.current } });
    const b = integrityBeacon(stateRef.current, sessionId);
    if (!b) {
      lastIntegrity.current = "";
      return;
    }
    if (b.sig !== lastIntegrity.current) {
      lastIntegrity.current = b.sig;
      diag("integrity", b.body);
    }
    // retire the reported violation on a fresh state object — everything
    // else in this hook writes via draft copies, never in-place edits
    if (stateRef.current.sunkLive)
      stateRef.current = { ...stateRef.current, sunkLive: undefined };
  }, [sessionId]);

  useEffect(() => {
    stateRef.current = emptySessionState();
    lastIntegrity.current = "";
    const life = { sid: sessionId, cancelled: false, generation: 0 };
    lifecycle.current = life;
    if (!sessionId) return () => { life.cancelled = true; };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let repairing = false;
    let seeded = false;
    const schedule = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!life.cancelled) push();
      }, 30);
    };
    const repair = (v: number) => {
      if (repairing) return;
      repairing = true;
      diag("viewgap", { s: sessionId, have: stateRef.current.v ?? 0, got: v });
      // The transport owns bounded retries, readiness and wanted ownership.
      void resubscribe("view", sessionId).catch(() => { repairing = false; });
    };
    const unsubView = streamSub("view", sessionId, (msg) => {
      const f = msg.view as ViewFrame | undefined;
      if (!f || life.cancelled) return;
      if (!seeded && f.t !== "snapshot") { repair(f.v); return; }
      const draft = { ...stateRef.current, items: [...stateRef.current.items] };
      let r: ReturnType<typeof applyViewFrame>;
      try {
        r = applyViewFrame(draft, f);
      } catch (err) {
        diag("jsrej", { m: `view:${f.t}: ${err instanceof Error ? err.message : err}` });
        return;
      }
      if (r === "gap") { repair(f.v); return; }
      if (r === "stale") return;
      if (f.t === "snapshot") {
        life.generation++;
        seeded = true;
        repairing = false;
      }
      stateRef.current = draft;
      schedule();
    });
    const unsubTx = streamSub("transcript", sessionId, (msg) => {
      const items = msg.items;
      if (life.cancelled || !seeded || !Array.isArray(items) || !items.length) return;
      const draft = { ...stateRef.current, items: [...stateRef.current.items] };
      try {
        applyDurableDelta(draft, items as TranscriptItem[]);
      } catch (err) {
        diag("jsrej", { m: `delta:${err instanceof Error ? err.message : err}` });
        return;
      }
      stateRef.current = draft;
      schedule();
    });
    const unsubState = onStreamState(setConnected);
    const unsubRestart = onServerRestart(() => {
      life.generation++;
      seeded = false;
      repairing = false;
      lastIntegrity.current = "";
      stateRef.current = emptySessionState();
      setBox({ sid: sessionId, state: stateRef.current });
    });
    return () => {
      life.cancelled = true;
      unsubView(); unsubTx(); unsubState(); unsubRestart();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [sessionId, push]);

  const loadOlder = () => {
    const life = lifecycle.current;
    if (!sessionId || !life || life.cancelled || life.sid !== sessionId) return Promise.resolve();
    const first = stateRef.current.durable?.find((i) => i.id.startsWith("bf-"));
    const nodeId = first ? Number(first.id.slice(3)) : 0;
    if (!nodeId) return Promise.resolve();
    const generation = life.generation;
    return api<{ items?: TranscriptItem[]; truncated?: boolean }>(
      `/api/sessions/${sessionId}/transcript?before=${nodeId}&tail=50`,
    ).then((r) => {
      if (life.cancelled || lifecycle.current !== life || life.generation !== generation) return;
      const cur = { ...stateRef.current, items: [...stateRef.current.items] };
      // View snapshots/patches already own the complete retained list.
      prependTranscript(cur, r.items ?? [], r.truncated ?? false);
      stateRef.current = cur;
      push();
    }).catch(() => {});
  };

  return { state: box.sid === sessionId ? box.state : emptySessionState(), connected, loadOlder };
}
