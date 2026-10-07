"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { scrollDecision } from "@/lib/client/stick";

// useLayoutEffect warns during SSR — these components are client-only but
// Next still prerenders them, so fall back to useEffect off-DOM.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Pin a scroll container to its bottom while `stick` holds.
 *
 *  - `dep` changes (new items) re-pin only while stuck
 *  - `resetKey` changes (session switch) restore pinning and land at the
 *    bottom — the previous session's scroll offset never leaks through
 *  - a ResizeObserver on the inner content wrapper follows growth that React
 *    doesn't commit: content-visibility resolution, images, late shiki output
 *  - scroll events from our own pins can't un-pin (they never move scrollTop
 *    up), so a stale event mid-replay can't leave the view at a random offset
 */
export function useStickToBottom(dep: unknown, resetKey: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const userInputAt = useRef(0);
  const gestureTop = useRef(0);
  const inputDelta = useRef(0);
  const touchY = useRef(-1);
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  // new view → always land at the bottom (scrollTop resets with the content).
  // Layout effect: pin before the first paint — the user never sees the
  // top-then-chase descent, and content-visibility growth afterwards
  // happens below the fold so the re-pins are invisible.
  useIsoLayoutEffect(() => {
    stick.current = true;
    lastTop.current = 0;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    queueMicrotask(() => setAtBottom(true));
  }, [resetKey]);

  useIsoLayoutEffect(() => {
    if (stick.current) pin();
  }, [dep, resetKey, pin]);

  // follow height changes React doesn't commit — content-visibility
  // resolving, images, late syntax highlight — only while pinned
  useEffect(() => {
    const content = scrollRef.current?.firstElementChild;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) pin();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [resetKey, pin]);

  // mark real user input — scroll anchoring and content-visibility
  // resolution also move scrollTop, but never alongside wheel/touch/key
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // input-side intent: scroll anchoring can fully mask scrollTop deltas
    // on c-v lists (offscreen items resolving taller push the position back
    // down), so upward intent is accumulated from the input events
    // themselves — finger travel and wheel delta can't be compensated away.
    const mark = (upIntent: number) => {
      const now = performance.now();
      // a new gesture after an idle gap re-baselines the cumulative check
      if (now - userInputAt.current > 300) {
        gestureTop.current = el.scrollTop;
        inputDelta.current = 0;
        touchY.current = -1;
      }
      // signed accumulation: scrolling back down cancels earlier upward
      // intent — otherwise intent banked at the start of a gesture keeps
      // reporting movedUp even while the user scrolls to the bottom, and
      // the pin can't re-engage until the gesture ends
      inputDelta.current = Math.max(0, inputDelta.current + upIntent);
      userInputAt.current = now;
    };
    const onWheel = (e: WheelEvent) => mark(-e.deltaY);
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (touchY.current < 0) touchY.current = y;
      mark(touchY.current - y);
      touchY.current = y;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") mark(1e6);
      else if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End") mark(-1e6);
      else mark(0);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
    };
  }, [resetKey]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const inputRecent = performance.now() - userInputAt.current < 300;
    const d = scrollDecision(el.scrollTop, lastTop.current, el.scrollHeight, el.clientHeight, inputRecent, gestureTop.current, inputDelta.current);
    lastTop.current = el.scrollTop;
    if (d.at) {
      stick.current = true;
      setAtBottom(true);
    } else if (d.unstick) {
      stick.current = false;
      setAtBottom(false);
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    stick.current = true;
    pin();
    setAtBottom(true);
  }, [pin]);

  // search-hit jumps etc: stop following until the user returns to the bottom
  const unpin = useCallback(() => {
    stick.current = false;
    setAtBottom(false);
  }, []);

  return { scrollRef, onScroll, atBottom, stick, jumpToBottom, unpin };
}
