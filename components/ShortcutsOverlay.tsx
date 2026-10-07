"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import Modal from "./Modal";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "General",
    keys: [
      ["?", "keyboard shortcuts"],
      ["⌘/Ctrl K", "session palette"],
      ["⌘/Ctrl .", "model picker"],
      ["Alt ↑ / Alt ↓", "previous / next session"],
      ["Esc", "close menu / overlay"],
    ],
  },
  {
    title: "Composer",
    keys: [
      ["Enter", "send"],
      ["⇧ Enter", "new line"],
      ["⇧ Tab", "cycle session mode (excl. Bypass)"],
      ["↑ / ↓", "prompt history"],
      ["@", "mention a file"],
      ["/", "session commands"],
    ],
  },
  {
    title: "Permission cards",
    keys: [
      ["Y", "allow once"],
      ["⇧ A", "allow always"],
      ["N", "reject"],
    ],
  },
];

export default function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <Modal
      onClose={onClose}
      label="Keyboard shortcuts"
      panelClassName="w-full max-w-sm rounded-xl border border-(--color-border) bg-(--color-panel) shadow-xl p-4"
    >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">Keyboard shortcuts</span>
          <button
            onClick={onClose}
            className="p-1 rounded text-(--color-dim) hover:text-white"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="space-y-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-tiny uppercase tracking-wider text-(--color-faint) mb-1.5">
                {g.title}
              </div>
              <div className="space-y-1">
                {g.keys.map(([k, label]) => (
                  <div key={k} className="flex items-center justify-between text-xs">
                    <span className="text-(--color-dim)">{label}</span>
                    <kbd className="mono text-tiny px-1.5 py-0.5 rounded border border-(--color-border) bg-(--color-panel2) text-(--color-text)">
                      {k}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
    </Modal>
  );
}
