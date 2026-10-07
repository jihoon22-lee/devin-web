"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Shared dialog frame. Renders through a portal so no ancestor transform or
 *  paint containment can turn `fixed` into a containing-block trap (the
 *  sidebar's md:translate-x-0 / .dw-virt issue), and owns the dialog
 *  contract: role/aria-modal, backdrop + Esc close, focus-in on open and
 *  focus-restore on close. */
export default function Modal({
  onClose,
  label,
  children,
  panelClassName,
  align = "center",
}: {
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** classes for the dialog panel itself (size/border/bg) */
  panelClassName?: string;
  /** "top" floats the panel near the viewport top (command palette style);
   *  "sheet" is a bottom sheet on phones (thumb-reachable) and a centered
   *  dialog on md+ */
  align?: "center" | "top" | "sheet";
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // an autoFocus child wins; otherwise the panel itself takes focus so
    // Esc works without a click and the dialog is reachable by keyboard
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => prev?.focus?.();
  }, []);

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex bg-(--color-scrim) backdrop-blur-[2px] ${
        align === "top"
          ? "items-start justify-center pt-[12vh] p-4"
          : align === "sheet"
            ? "items-end md:items-center justify-center p-0 md:p-4"
            : "items-center justify-center p-4"
      }`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`outline-none ${panelClassName ?? ""}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
