"use client";

import { useEffect, useRef } from "react";
import { EDGE_MAX, EDGE_MIN, swipeAction } from "@/lib/client/swipe";

const isMobile = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

/** Mobile drawer gestures — swipe in from the edge band opens, a left swipe
 *  closes (mirrors the scrim tap). */
export function useMobileSidebarSwipe(open: boolean | null, setOpen: (v: boolean) => void) {
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    let sx = 0;
    let sy = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      if (!isMobile()) return;
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      tracking = (sx >= EDGE_MIN && sx < EDGE_MAX) || openRef.current === true;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const a = swipeAction({ sx, dx: t.clientX - sx, dy: t.clientY - sy, open: openRef.current === true });
      if (a === "open") setOpen(true);
      else if (a === "close") setOpen(false);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [setOpen]);
}

/** ⌘/Ctrl+K toggles the session palette; `?` (outside text fields) the
 *  shortcut help; ⌘/Ctrl+. opens the model picker (a deliberate chord —
 *  fires even while typing in the composer). */
export function useGlobalShortcuts({
  onPalette,
  onShortcuts,
  onModelPicker,
}: {
  onPalette: () => void;
  onShortcuts: () => void;
  onModelPicker?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onPalette();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        onModelPicker?.();
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === "?") onShortcuts();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPalette, onShortcuts, onModelPicker]);
}
