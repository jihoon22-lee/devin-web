"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/client/api";
import type { Health } from "@/lib/client/health";
import Modal from "./Modal";

/** Everything /api/health knows, refreshed every 5s. The badge's toasts fire
 *  only on transitions — this is the steady-state view. */
const fmtBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

export default function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Health>("/api/health")
        .then((r) => {
          if (cancelled) return;
          setH(r);
          setErr(null);
        })
        .catch((e) => {
          if (!cancelled) setErr((e as Error).message);
        });
    void load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const rows: [string, string][] = h
    ? [
        ["agent", h.acp.alive ? `running · pid ${h.acp.pid} · ${h.acp.via ?? "?"}` : "not running"],
        ["degraded", h.acp.degraded ?? "no"],
        ["terminal host", h.host == null ? "local mode" : h.host ? "reachable" : "UNREACHABLE"],
        ["streams", h.stream ? `${h.stream.live}/${h.stream.connections} live · ${h.stream.subs} subs` : "—"],
        ["session views", String(h.view?.sessions ?? 0)],
        ["attached sessions", String(h.attached)],
        ["devin", `${h.devin?.version ?? "?"} · ${h.devin?.authed === false ? "LOGGED OUT" : "logged in"}`],
        ["CLI schema", h.cliSchema?.status === "drift"
          ? `MISMATCH · ${h.cliSchema.missing.join(", ")} · migration ${h.cliSchema.version ?? "unknown"}`
          : h.cliSchema?.status === "unavailable"
            ? "UNAVAILABLE · sessions.db could not be read"
            : h.cliSchema?.status === "compatible"
              ? `compatible · migration ${h.cliSchema.version ?? "unknown"}`
              : "unknown"],
        ["web uptime", `${Math.floor(h.uptime / 60)}m`],
        ["integrity alarms", h.integrity ? `${h.integrity.total}${h.integrity.lastAt ? ` · last ${new Date(h.integrity.lastAt).toLocaleString()}` : ""}` : "—"],
        ...(h.storage
          ? ([
              ["state storage", `${fmtBytes(h.storage.total)}${h.storage.warn.length ? ` · LARGE: ${h.storage.warn.join(", ")}` : ""}`],
              ...Object.entries(h.storage.files)
                .filter(([, n]) => n > 0)
                .map(([f, n]) => [`  ${f}`, fmtBytes(n)] as [string, string]),
            ] as [string, string][])
          : []),
      ]
    : [];

  return (
    <Modal onClose={onClose} label="Diagnostics" align="sheet"
      panelClassName="w-full md:max-w-md max-h-[88dvh] overflow-y-auto rounded-t-2xl md:rounded-xl pb-[env(safe-area-inset-bottom)] border border-(--color-border) bg-(--color-panel) shadow-xl"
    >
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border)">
          <span className="text-sm font-medium">Diagnostics</span>
          <button onClick={onClose} className="p-1 rounded text-(--color-dim) hover:text-white" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <dl className="px-4 py-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {err && <dd className="col-span-2 text-(--color-red)">{err}</dd>}
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-(--color-faint)">{k}</dt>
              <dd className="mono text-(--color-dim) break-all">{v}</dd>
            </div>
          ))}
        </dl>
        {!!h?.storage?.warn.length && (
          <p className="px-4 pb-3 text-2xs text-(--color-warning)">
            {h.storage.warn.join(", ")} passed 1 GB.
            {h.storage.warn.includes("search.db") && " The search cache is rebuildable: `bin/devin-web-ctl search-compact` rebuilds and vacuums it (the server pauses a few seconds)."}
          </p>
        )}
    </Modal>
  );
}
