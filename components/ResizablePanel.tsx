"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  PANEL_DEFAULT, PANEL_MIN, clampPanelWidth, loadPanelWidth, savePanelWidth, type PanelTab,
} from "@/lib/client/panelWidth";

/** Desktop side panel (Files / Changes / Terminals) docked to the RIGHT of
 *  the chat column with a draggable left edge. Mounted per tab (`key={tab}`
 *  at the call site) and only after the user picks a tab — never
 *  server-rendered — so the stored width can be read in the initializer
 *  without a hydration mismatch or a first-frame flash. Phones keep the
 *  full-width panel; the handle is md+ only. */
export default function ResizablePanel({ tab, children }: { tab: PanelTab; children: ReactNode }) {
  const [width, setWidth] = useState(() => loadPanelWidth(tab));
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const containerWidth = () => {
    const w = boxRef.current?.parentElement?.clientWidth ?? 0;
    return w > 0 ? w : window.innerWidth;
  };
  const commit = (w: number) => {
    setWidth(w);
    savePanelWidth(tab, w);
  };

  return (
    <div
      ref={boxRef}
      className="relative flex min-h-0 w-full md:w-(--dw-panel-w) md:max-w-[calc(100%-320px)] md:shrink-0 md:border-l md:border-(--color-border)"
      style={{ "--dw-panel-w": `${width}px` } as CSSProperties}
    >
      <div className="flex-1 min-w-0 flex">{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={PANEL_MIN}
        aria-label="Resize panel"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        className="hidden md:block absolute top-0 -left-1 h-full w-2 z-10 cursor-col-resize hover:bg-(--color-accent)/30 active:bg-(--color-accent)/50"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { startX: e.clientX, startW: width };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setWidth(clampPanelWidth(drag.current.startW - (e.clientX - drag.current.startX), containerWidth()));
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          savePanelWidth(tab, width);
        }}
        onDoubleClick={() => commit(PANEL_DEFAULT[tab])}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          commit(clampPanelWidth(width + (e.key === "ArrowLeft" ? 16 : -16), containerWidth()));
        }}
      />
    </div>
  );
}
