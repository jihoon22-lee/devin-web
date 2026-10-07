"use client";

// Session configuration bar — replaces the old native <select> row in
// ChatInput. Mode and model get chip+popover pickers as separate controls
// on every screen; thought_level renders as a segment group beside the
// model chip so level changes are one click, and every other config option
// (speed, booleans, …) gets a generic control. A requested value shows
// optimistically via `pending` until the agent echoes it back (or a 2s
// grace elapses).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyEvent } from "react";
import { Check, ChevronDown, ImageOff, Search } from "lucide-react";
import type { SessionConfigOption } from "@/lib/acp/types";
import type { SessionState } from "@/lib/client/model";
import { api, setConfig } from "@/lib/client/api";
import { isImeComposing } from "@/lib/client/keys";
import {
  classifyConfig,
  loadRecentModels,
  modeIcon,
  modelEffortTag,
  modelGroup,
  optionSupportsImages,
  pushRecentModel,
  shortModelName,
} from "@/lib/client/configOptions";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmDialog";

type OptEntry = NonNullable<SessionConfigOption["options"]>[number];

/** config ids remembered as the default for future sessions (mode is
 *  deliberately excluded — Bypass must never leak into a new session) */
const DEFAULTABLE = new Set(["model", "thought_level", "speed"]);

const chipCls =
  "flex items-center gap-1.5 px-2 py-1 rounded-md bg-(--color-panel2) border border-(--color-border) " +
  "text-(--color-text) hover:border-(--color-border2) disabled:opacity-50";
const sectionLabel = "text-tiny uppercase tracking-wider text-(--color-faint) px-1 pt-3 pb-1";

/** Optimistic config changes: display = pending[id] ?? currentValue.
 *  Pending clears when the server echoes the value (config_option_update)
 *  or 2s after the request resolves; a failure rolls back and toasts. */
function usePendingConfig(sessionId: string, options: SessionConfigOption[] | undefined) {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, string | boolean>>({});
  // synchronous mirror so a same-tick second set() is really ignored
  const pendingRef = useRef<Record<string, string | boolean>>({});

  const drop = useCallback((id: string) => {
    if (!(id in pendingRef.current)) return;
    const n = { ...pendingRef.current };
    delete n[id];
    pendingRef.current = n;
    setPending(n);
  }, []);

  // the echoed configOptions carry the confirmed value → drop pending sooner
  useEffect(() => {
    queueMicrotask(() => {
      const p = pendingRef.current;
      const n = { ...p };
      let changed = false;
      for (const [id, v] of Object.entries(p)) {
        const o = options?.find((o) => o.id === id);
        if (o && o.currentValue === v) {
          delete n[id];
          changed = true;
        }
      }
      if (changed) {
        pendingRef.current = n;
        setPending(n);
      }
    });
  }, [options]);

  const set = useCallback(
    (configId: string, value: string | boolean) => {
      if (configId in pendingRef.current) return; // already in flight
      pendingRef.current = { ...pendingRef.current, [configId]: value };
      setPending(pendingRef.current);
      const label = options?.find((o) => o.id === configId)?.name || configId;
      // a model switch makes the agent reset thought_level (and possibly
      // other selects) to the defaults baked into the model id — capture
      // current values so still-valid ones can be re-applied
      const keep: Record<string, string | boolean> = {};
      if (configId === "model" && typeof value === "string") {
        const c = classifyConfig(options);
        for (const o of [c.thought, ...c.extra]) {
          if (!o) continue;
          const v = pendingRef.current[o.id] ?? o.currentValue;
          if (v !== undefined && v !== "") keep[o.id] = v;
        }
      }
      setConfig(sessionId, configId, value)
        .then((res) => {
          const body = res as
            | { configOptions?: SessionConfigOption[]; error?: string }
            | undefined;
          if (body?.error) {
            drop(configId);
            toast(`${label} change failed: ${body.error}`);
            return;
          }
          if (DEFAULTABLE.has(configId) && typeof value === "string") {
            if (configId === "model") pushRecentModel(value);
            void api("/api/ui-state", {
              method: "PUT",
              body: JSON.stringify({ sessionDefaults: { [configId]: value } }),
            }).catch(() => {});
          }
          for (const [id, prev] of Object.entries(keep)) {
            const n = body?.configOptions?.find((o) => o.id === id);
            // re-apply only a still-offered value the switch actually reset;
            // option-less extras (booleans) re-apply on any reset
            const offered = n?.options?.length
              ? n.options.some((o) => o.value === prev)
              : true;
            if (!n || n.currentValue === prev || !offered) continue;
            // a stale in-flight pick must not block the re-apply
            delete pendingRef.current[id];
            pendingRef.current = { ...pendingRef.current, [id]: prev };
            setPending(pendingRef.current);
            const lbl = n.name || id;
            setConfig(sessionId, id, prev)
              .then((r) => {
                const b = r as { error?: string } | undefined;
                if (b?.error) {
                  drop(id);
                  toast(`${lbl} change failed: ${b.error}`);
                } else {
                  window.setTimeout(() => drop(id), 2000);
                }
              })
              .catch((e) => {
                drop(id);
                toast(`${lbl} change failed: ${(e as Error).message}`);
              });
          }
          // grace window for the config_option_update echo, then stop
          // showing the optimistic value even if it never arrives
          window.setTimeout(() => drop(configId), 2000);
        })
        .catch((e) => {
          drop(configId);
          toast(`${label} change failed: ${(e as Error).message}`);
        });
    },
    [sessionId, options, toast, drop],
  );

  return { pending, set };
}

/** Mode options list for the mode chip popover. */
function ModeList({
  opt,
  value,
  onPick,
}: {
  opt: SessionConfigOption;
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div role="menu" aria-label={opt.name || "Mode"}>
      {(opt.options ?? []).map((o) => {
        const Icon = modeIcon(o);
        const danger = o.value === "bypass";
        return (
          <button
            key={o.value}
            role="menuitem"
            onClick={() => onPick(o.value)}
            className={`w-full flex items-start gap-2 px-3 py-2 text-left ${
              danger
                ? "text-(--color-red) hover:bg-(--color-red)/10"
                : "text-(--color-text) hover:bg-(--color-panel3)"
            }`}
          >
            {Icon ? (
              <Icon size={14} className="mt-0.5 shrink-0" />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <span className="flex-1 min-w-0">
              <span className="block text-xs">{o.name}</span>
              {o.description && (
                <span className="block text-2xs text-(--color-faint) whitespace-normal">
                  {o.description}
                </span>
              )}
            </span>
            {o.value === value && (
              <Check size={13} className="mt-0.5 shrink-0 text-(--color-accent)" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Searchable model list — MRU "Recent" section then prefix groups, with
 *  ↑/↓/Enter/Esc keyboard nav. */
function ModelPicker({
  opt,
  value,
  onPick,
  onClose,
}: {
  opt: SessionConfigOption;
  value: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);

  const all = opt.options ?? [];
  const lq = q.trim().toLowerCase();
  const filtered = lq
    ? all.filter(
        (o) => o.name.toLowerCase().includes(lq) || o.value.toLowerCase().includes(lq),
      )
    : all;
  const recent = loadRecentModels()
    .map((v) => filtered.find((o) => o.value === v))
    .filter((o): o is OptEntry => !!o);
  const recentSet = new Set(recent.map((o) => o.value));
  const byGroup = new Map<string, OptEntry[]>();
  for (const o of filtered) {
    if (recentSet.has(o.value)) continue;
    const g = modelGroup(o.value);
    const arr = byGroup.get(g);
    if (arr) arr.push(o);
    else byGroup.set(g, [o]);
  }
  const flat = [...recent, ...[...byGroup.values()].flat()];
  const sel = Math.min(hi, Math.max(0, flat.length - 1));

  const onKey = (e: ReactKeyEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[sel]) onPick(flat[sel].value);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  let rowIdx = -1;
  const renderRow = (o: OptEntry) => {
    const i = ++rowIdx;
    const noImages = optionSupportsImages(opt, o.value) === false;
    const effort = modelEffortTag(o.value, o.name);
    return (
      <button
        key={o.value}
        role="option"
        aria-selected={o.value === value}
        onMouseEnter={() => setHi(i)}
        onClick={() => onPick(o.value)}
        ref={(el) => {
          if (i === sel) el?.scrollIntoView({ block: "nearest" });
        }}
        className={`w-full flex items-start gap-2 px-3 py-1.5 text-left ${
          i === sel ? "bg-(--color-panel3)" : "hover:bg-(--color-panel3)"
        }`}
      >
        <span className="flex-1 min-w-0 whitespace-normal break-words text-xs text-(--color-text)">
          {o.name}
          {effort && <span className="text-(--color-faint)"> · {effort}</span>}
        </span>
        {noImages && (
          <span title="no image input" className="mt-0.5 shrink-0 text-(--color-faint)">
            <ImageOff size={12} aria-label="no image input" />
          </span>
        )}
        {o.value === value && (
          <Check size={13} className="mt-0.5 shrink-0 text-(--color-accent)" />
        )}
      </button>
    );
  };

  return (
    <div>
      <div className="sticky top-0 z-10 bg-(--color-panel2) p-2 border-b border-(--color-border)">
        <div className="flex items-center gap-2 px-2 py-1 rounded bg-(--color-panel) border border-(--color-border)">
          <Search size={12} className="text-(--color-faint) shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={onKey}
            placeholder="Search models…"
            aria-label="Search models"
            className="flex-1 min-w-0 bg-transparent outline-none text-xs placeholder:text-(--color-faint)"
          />
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto py-1" role="listbox" aria-label={opt.name || "Model"}>
        {recent.length > 0 && (
          <div>
            <div className={sectionLabel}>Recent</div>
            {recent.map(renderRow)}
          </div>
        )}
        {[...byGroup.entries()].map(([g, os]) => (
          <div key={g}>
            <div className={sectionLabel}>{g}</div>
            {os.map(renderRow)}
          </div>
        ))}
        {flat.length === 0 && (
          <div className="px-3 py-3 text-xs text-(--color-faint)">No matches</div>
        )}
      </div>
    </div>
  );
}

/** Segmented control for select options with a small option count. */
function Segment({
  opt,
  value,
  disabled,
  runningHint,
  onPick,
}: {
  opt: SessionConfigOption;
  value: string;
  disabled?: boolean;
  runningHint?: string;
  onPick: (v: string) => void;
}) {
  return (
    <div
      className="flex rounded-md border border-(--color-border) overflow-hidden shrink-0"
      role="group"
      aria-label={opt.name || opt.id}
    >
      {(opt.options ?? []).map((o) => (
        <button
          key={o.value}
          onClick={() => onPick(o.value)}
          disabled={disabled}
          aria-pressed={o.value === value}
          title={runningHint ?? o.description ?? o.name}
          className={`px-2 py-1 text-xs disabled:opacity-50 ${
            o.value === value
              ? "bg-(--color-accent) text-black"
              : "bg-(--color-panel2) text-(--color-dim) hover:text-(--color-text)"
          }`}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

/** Generic control for non-mode/model/thought options: boolean → switch,
 *  ≤3 select options → segment, more → compact dropdown. */
function ExtraControl({
  opt,
  value,
  disabled,
  runningHint,
  onPick,
}: {
  opt: SessionConfigOption;
  value: string | boolean;
  disabled?: boolean;
  runningHint?: string;
  onPick: (v: string | boolean) => void;
}) {
  const label = opt.name || opt.id;
  if (opt.type === "boolean") {
    const on = value === true;
    return (
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={runningHint ?? label}
        disabled={disabled}
        onClick={() => onPick(!on)}
        className="flex items-center gap-1.5 text-xs text-(--color-dim) disabled:opacity-50 shrink-0"
      >
        <span
          className={`relative w-7 h-4 rounded-full transition ${
            on ? "bg-(--color-accent)" : "bg-(--color-panel3)"
          }`}
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition ${
              on ? "left-3.5" : "left-0.5"
            }`}
          />
        </span>
        {label}
      </button>
    );
  }
  const opts = opt.options ?? [];
  if (opts.length <= 3) {
    return (
      <Segment
        opt={opt}
        value={String(value)}
        disabled={disabled}
        runningHint={runningHint}
        onPick={onPick}
      />
    );
  }
  const cur = String(value);
  return (
    <label className="flex items-center gap-1 text-(--color-dim) shrink-0">
      <span>{label}:</span>
      <select
        value={cur}
        disabled={disabled}
        aria-label={label}
        title={runningHint ?? label}
        onChange={(e) => onPick(e.target.value)}
        className="bg-(--color-panel2) border border-(--color-border) rounded px-1.5 py-1 text-xs text-(--color-text) outline-none max-w-[140px]"
      >
        {!opts.some((o) => o.value === cur) && <option value={cur}>{cur}</option>}
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function ConfigBar({
  sessionId,
  state,
}: {
  sessionId: string;
  state: SessionState;
}) {
  const options = state.configOptions;
  const cfg = useMemo(() => classifyConfig(options), [options]);
  const { pending, set } = usePendingConfig(sessionId, options);
  const confirm = useConfirm();
  const [open, setOpen] = useState<"mode" | "model" | null>(null);

  const valueOf = useCallback(
    (o: SessionConfigOption) => pending[o.id] ?? o.currentValue ?? "",
    [pending],
  );

  /** pick a value — Bypass Permissions is guarded by a confirm */
  const applyValue = useCallback(
    (o: SessionConfigOption, v: string | boolean) => {
      if (v === "bypass" && valueOf(o) !== "bypass") {
        void confirm({
          title: "Switch to Bypass Permissions?",
          body: "Bypass auto-approves all tool calls in this session.",
          confirmLabel: "Switch to Bypass",
          danger: true,
        }).then((r) => {
          if (r === "confirm") set(o.id, v);
        });
        return;
      }
      set(o.id, v);
    },
    [set, valueOf, confirm],
  );

  // window-event handlers (⌘. palette/shortcut, Shift+Tab in the composer)
  // run outside React — give them a live snapshot of cfg + pending
  const live = useRef({ cfg, pending });
  useEffect(() => {
    live.current = { cfg, pending };
  });
  useEffect(() => {
    const openModel = () => {
      if (live.current.cfg.model) setOpen("model");
    };
    const cycleMode = () => {
      const { cfg: c, pending: p } = live.current;
      const m = c.mode;
      const opts = m?.options ?? [];
      if (!m || opts.length < 2) return;
      const cur = String(p[m.id] ?? m.currentValue ?? "");
      const idx = Math.max(0, opts.findIndex((o) => o.value === cur));
      for (let i = 1; i <= opts.length; i++) {
        const n = opts[(idx + i) % opts.length];
        if (n.value === "bypass") continue; // never cycle into Bypass
        set(m.id, n.value);
        return;
      }
    };
    window.addEventListener("dw-open-model-picker", openModel);
    window.addEventListener("dw-cycle-mode", cycleMode);
    return () => {
      window.removeEventListener("dw-open-model-picker", openModel);
      window.removeEventListener("dw-cycle-mode", cycleMode);
    };
  }, [set]);

  // Esc closes whichever popup is up (click-away handles pointer dismissals)
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const running = state.running;
  const hint = running ? "Applies to the next message" : undefined;

  const modeOpt = cfg.mode;
  const modeVal = modeOpt ? String(valueOf(modeOpt)) : "";
  const modelVal = cfg.model ? String(valueOf(cfg.model)) : "";
  const modeName = modeOpt
    ? (modeOpt.options?.find((o) => o.value === modeVal)?.name ?? modeVal)
    : "";
  // icon element, not a component binding — a `const ModeIcon` in component
  // scope trips react-hooks/static-components (render-scope component)
  const modeGlyph = (className: string) => {
    const I = modeOpt ? modeIcon(modeOpt.options?.find((o) => o.value === modeVal)) : undefined;
    return I ? <I size={12} className={className} /> : null;
  };

  const queued = state.queued > 0 && (
    <span className="text-(--color-status-input)">+{state.queued} queued</span>
  );

  return (
    <div className="flex items-center gap-2 mb-2 text-xs flex-wrap">
      {cfg.mode && (
        <span className="relative">
          <button
            onClick={() => setOpen(open === "mode" ? null : "mode")}
            disabled={cfg.mode.id in pending}
            aria-haspopup="menu"
            aria-expanded={open === "mode"}
            title={hint ?? cfg.mode.name ?? "Mode"}
            className={`${chipCls} ${modeVal === "bypass" ? "text-(--color-red)" : ""}`}
          >
            {modeGlyph("shrink-0")}
            <span>{modeName}</span>
            <ChevronDown size={11} className="text-(--color-faint)" />
          </button>
          {open === "mode" && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(null)} />
              <div className="absolute bottom-full mb-1 left-0 z-50 w-64 rounded-lg border border-(--color-border) bg-(--color-panel2) shadow-xl py-1 dw-pop">
                <ModeList
                  opt={cfg.mode}
                  value={modeVal}
                  onPick={(v) => {
                    setOpen(null);
                    if (cfg.mode) applyValue(cfg.mode, v);
                  }}
                />
              </div>
            </>
          )}
        </span>
      )}
      {cfg.model && (
        <span className="relative">
          <button
            onClick={() => setOpen(open === "model" ? null : "model")}
            disabled={cfg.model.id in pending}
            aria-haspopup="listbox"
            aria-expanded={open === "model"}
            title={hint ?? cfg.model.name ?? "Model"}
            className={chipCls}
          >
            <span className="truncate max-w-48">{shortModelName(cfg.model, modelVal)}</span>
            <ChevronDown size={11} className="text-(--color-faint)" />
          </button>
          {open === "model" && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(null)} />
              <div className="absolute bottom-full mb-1 left-0 z-50 w-72 max-w-[85vw] rounded-lg border border-(--color-border) bg-(--color-panel2) shadow-xl dw-pop">
                <ModelPicker
                  opt={cfg.model}
                  value={modelVal}
                  onClose={() => setOpen(null)}
                  onPick={(v) => {
                    setOpen(null);
                    if (cfg.model) applyValue(cfg.model, v);
                  }}
                />
              </div>
            </>
          )}
        </span>
      )}
      {cfg.thought && (
        <Segment
          opt={cfg.thought}
          value={String(valueOf(cfg.thought))}
          disabled={cfg.thought.id in pending}
          runningHint={hint}
          onPick={(v) => {
            if (cfg.thought) applyValue(cfg.thought, v);
          }}
        />
      )}
      {cfg.extra.map((o) => (
        <ExtraControl
          key={o.id}
          opt={o}
          value={valueOf(o)}
          disabled={o.id in pending}
          runningHint={hint}
          onPick={(v) => applyValue(o, v)}
        />
      ))}
      {queued}
    </div>
  );
}
