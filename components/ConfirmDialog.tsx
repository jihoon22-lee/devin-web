"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import Modal from "./Modal";

export type ConfirmResult = "confirm" | "alt" | null;

export interface ConfirmOptions {
  title: string;
  /** extra detail under the title — `\n` is preserved */
  body?: ReactNode;
  /** primary action label (default "Confirm") */
  confirmLabel?: string;
  cancelLabel?: string;
  /** third button between cancel and confirm — resolves "alt" */
  altLabel?: string;
  /** red primary button for destructive actions */
  danger?: boolean;
}

type Pending = ConfirmOptions & { resolve: (r: ConfirmResult) => void };

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<ConfirmResult>>(async () => null);

/** Promise-based confirm — `await confirm({...})` resolves "confirm",
 * "alt", or null (cancel/Esc/backdrop). */
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (o: ConfirmOptions) => new Promise<ConfirmResult>((resolve) => setPending({ ...o, resolve })),
    [],
  );
  const done = (r: ConfirmResult) => {
    pending?.resolve(r);
    setPending(null);
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <Modal
          onClose={() => done(null)}
          label={pending.title}
          panelClassName="w-full max-w-sm rounded-xl border border-(--color-border) bg-(--color-panel) shadow-2xl p-4 dw-pop"
        >
          <div className="text-sm font-medium">{pending.title}</div>
          {pending.body != null && (
            <div className="mt-2 text-xs text-(--color-dim) whitespace-pre-wrap max-h-60 overflow-y-auto">
              {pending.body}
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              onClick={() => done(null)}
              className="px-3 py-1.5 rounded-lg border border-(--color-border) text-xs text-(--color-dim) hover:text-white hover:bg-(--color-panel2)"
            >
              {pending.cancelLabel ?? "Cancel"}
            </button>
            {pending.altLabel && (
              <button
                onClick={() => done("alt")}
                className="px-3 py-1.5 rounded-lg border border-(--color-accent)/50 text-xs text-(--color-accent) hover:bg-(--color-accent)/10"
              >
                {pending.altLabel}
              </button>
            )}
            <button
              autoFocus
              onClick={() => done("confirm")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                pending.danger
                  ? "bg-(--color-red)/80 text-black hover:bg-(--color-red)"
                  : "bg-(--color-accent) text-black hover:brightness-110"
              }`}
            >
              {pending.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
