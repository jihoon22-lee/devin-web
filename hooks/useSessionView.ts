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

const waitingForDurable = (state: SessionState) =>
  (state.durableScannedThrough ?? state.durableThrough ?? 0) < (state.durableThrough ?? 0);

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
    // Keep the last coherent regions on screen across the view/transcript
    // delivery seam. Metadata and the completed turn become visible together.
    if (waitingForDurable(stateRef.current)) return;
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
    let durableTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingRows: TranscriptItem[] = [];
    let scannedThrough = 0;
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
    const deliveryWait = () => {
      if (!waitingForDurable(stateRef.current)) {
        if (durableTimer) clearTimeout(durableTimer);
        durableTimer = null;
      } else if (!durableTimer) {
        // This is a recovery deadline, not a grace period for silencing
        // integrity checks. A completed scan still reports missing anchors.
        durableTimer = setTimeout(() => {
          durableTimer = null;
          if (life.cancelled || !waitingForDurable(stateRef.current)) return;
          diag("durablegap", { s: sessionId, have: stateRef.current.durableScannedThrough, want: stateRef.current.durableThrough });
          repair(stateRef.current.v ?? 0);
        }, 2000);
      }
    };
    const applyPending = (draft: SessionState, rows: TranscriptItem[] = [], delivered = scannedThrough) => {
      const through = draft.durableThrough ?? 0;
      const all = [...pendingRows, ...rows];
      applyDurableDelta(draft, all);
      const future = all.filter(row => (row.id ?? 0) > through);
      draft.durableScannedThrough = Math.max(draft.durableScannedThrough ?? 0, Math.min(delivered, through));
      pendingRows = future;
      scannedThrough = delivered;
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
        pendingRows = [];
        scannedThrough = f.durableThrough;
      } else {
        applyPending(draft);
      }
      stateRef.current = draft;
      deliveryWait();
      schedule();
    });
    const unsubTx = streamSub("transcript", sessionId, (msg) => {
      const items = msg.items;
      if (life.cancelled || !seeded || !Array.isArray(items)) return;
      const draft = { ...stateRef.current, items: [...stateRef.current.items] };
      try {
        if (items.some(row => !row || !Number.isSafeInteger(row.id) || row.id < 0))
          throw new Error("invalid transcript node id");
        const lastId = msg.lastId;
        // Old senders/tests may omit lastId; visible rows still prove progress.
        const delivered = Number.isSafeInteger(lastId) && (lastId as number) >= 0
          ? lastId as number : items.reduce((n, row) => Number.isSafeInteger(row?.id) ? Math.max(n, row.id) : n, 0);
        applyPending(draft, items as TranscriptItem[], Math.max(scannedThrough, delivered));
      } catch (err) {
        diag("jsrej", { m: `delta:${err instanceof Error ? err.message : err}` });
        return;
      }
      stateRef.current = draft;
      if (pendingRows.length > 4096) {
        // Bound reordering storage. The fresh snapshot supplies the canonical
        // tail instead of silently forgetting already acknowledged rows.
        pendingRows = [];
        scannedThrough = draft.durableScannedThrough ?? 0;
        repair(draft.v ?? 0);
      }
      deliveryWait();
      schedule();
    });
    const unsubState = onStreamState(setConnected);
    const unsubRestart = onServerRestart(() => {
      life.generation++;
      seeded = false;
      repairing = false;
      lastIntegrity.current = "";
      stateRef.current = emptySessionState();
      pendingRows = [];
      scannedThrough = 0;
      if (durableTimer) clearTimeout(durableTimer);
      durableTimer = null;
      setBox({ sid: sessionId, state: stateRef.current });
    });
    return () => {
      life.cancelled = true;
      unsubView(); unsubTx(); unsubState(); unsubRestart();
      if (flushTimer) clearTimeout(flushTimer);
      if (durableTimer) clearTimeout(durableTimer);
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
