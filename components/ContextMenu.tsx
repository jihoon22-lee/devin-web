"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Fixed-position floating menu rendered in a portal — clamps to the viewport,
 *  closes on outside click / Esc / scroll / resize. */
export function FloatMenu({
  x,
  y,
  items,
  onClose,
  anchor,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** element the menu belongs to — only scrolls that move it close the menu */
  anchor?: Element | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
        if (!btns.length) return;
        const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (cur + 1) % btns.length : (cur - 1 + btns.length) % btns.length;
        btns[next].focus();
      }
    };
    // close on scroll — never for scrolling inside the menu, and, when the menu
    // has an anchor, only for scrolls that actually move that anchor (the chat
    // auto-scrolling beside a header button must not close its menu)
    const openedAt = performance.now();
    const scroll = (e: Event) => {
      // the opening tap's own focus/scroll-into-view lands a frame later
      // (scroll events are async) — on a phone that closed a menu opened
      // from a row near the bottom edge before it ever painted
      if (performance.now() - openedAt < 300) return;
      const el = ref.current;
      const t = e.target;
      if (el && t instanceof Node && el.contains(t)) return;
      if (anchor && !(t instanceof Node && t.contains(anchor))) return;
      onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose, anchor]);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60]"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-[61] min-w-44 rounded-xl border border-(--color-border2) bg-(--color-panel2) shadow-2xl py-1 overflow-hidden dw-pop"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-40 ${
              it.danger ? "text-(--color-red) hover:bg-(--color-red)/10" : "text-(--color-text) hover:bg-(--color-panel3)"
            }`}
          >
            {it.icon && <span className="text-(--color-dim) shrink-0">{it.icon}</span>}
            {it.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** Button + dropdown anchored to it. */
export function Dropdown({
  trigger,
  items,
  title,
  className = "",
}: {
  trigger: ReactNode;
  items: MenuItem[];
  title?: string;
  className?: string;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; el: Element | null } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        title={title}
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        className={className}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setAnchor({ x: r.right - 176, y: r.bottom + 6, el: btnRef.current });
        }}
      >
        {trigger}
      </button>
      {anchor && (
        <FloatMenu x={anchor.x} y={anchor.y} anchor={anchor.el} items={items} onClose={() => setAnchor(null)} />
      )}
    </>
  );
}
