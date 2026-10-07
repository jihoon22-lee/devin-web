"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Info, X } from "lucide-react";

export interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const arm = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );
  const push = useCallback(
    (text: string, kind: Toast["kind"] = "error") => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, kind, text }]);
      arm(id, kind === "error" ? 8000 : 4000);
    },
    [arm],
  );
  const pause = useCallback((id: number) => clearTimeout(timers.current.get(id)), []);
  const resume = useCallback((id: number) => arm(id, 3000), [arm]);
  return { toasts, push, dismiss, pause, resume };
}

export function Toasts({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onPause?: (id: number) => void;
  onResume?: (id: number) => void;
}) {
  if (!toasts.length) return null;
  return (
    // top placement keeps toasts clear of the composer/Send button on mobile
    <div className="fixed top-16 right-4 left-4 sm:left-auto z-[70] flex flex-col gap-2 sm:max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          onMouseEnter={() => onPause?.(t.id)}
          onMouseLeave={() => onResume?.(t.id)}
          className={`dw-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm shadow-2xl backdrop-blur-sm ${
            t.kind === "error"
              ? "bg-(--color-toast-danger-bg)/95 border-(--color-danger)/40 text-(--color-toast-danger-text)"
              : "bg-(--color-toast-info-bg)/95 border-(--color-accent)/40 text-(--color-toast-info-text)"
          }`}
        >
          {t.kind === "error" ? (
            <AlertTriangle size={15} className="text-(--color-red) shrink-0 mt-0.5" />
          ) : (
            <Info size={15} className="text-(--color-accent) shrink-0 mt-0.5" />
          )}
          <span className="flex-1 min-w-0 break-words">{t.text}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="p-1 -m-1 rounded text-current opacity-60 hover:opacity-100 shrink-0"
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

/** App-wide toasts so any component can surface a failed action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, push, dismiss, pause, resume } = useToasts();
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <Toasts toasts={toasts} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
