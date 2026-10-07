"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Monitor, Moon, Plus, ShieldOff, Sun, Trash2, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useConfirm } from "./ConfirmDialog";
import Modal from "./Modal";
import { useToast } from "./Toasts";
import { isImeComposing } from "@/lib/client/keys";
import { loadThemePref, saveThemePref, type ThemePref } from "@/lib/client/theme";
import { disablePush, enablePush, pushStatus, testPush, type PushStatus } from "@/lib/client/push";
import { parseTokens, useUiPrefs, type Snippet } from "@/lib/client/uiPrefs";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="py-4 border-t border-(--color-border) first:border-t-0 first:pt-1">
      <h3 className="text-sm font-medium text-(--color-text)">{title}</h3>
      {hint && <p className="text-2xs text-(--color-dim) mt-0.5">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const THEMES: { id: ThemePref; label: string; icon: React.ReactNode }[] = [
  { id: "system", label: "System", icon: <Monitor size={15} /> },
  { id: "light", label: "Light", icon: <Sun size={15} /> },
  { id: "dark", label: "Dark", icon: <Moon size={15} /> },
];

function ThemePicker() {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => queueMicrotask(() => setPref(loadThemePref())), []);
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-(--color-panel2) p-1">
      {THEMES.map((t) => (
        <button
          key={t.id}
          role="radio"
          aria-checked={pref === t.id}
          onClick={() => {
            setPref(t.id);
            saveThemePref(t.id);
          }}
          className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm transition-colors ${
            pref === t.id ? "bg-(--color-panel) text-white shadow-sm" : "text-(--color-dim) hover:text-white"
          }`}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

const PUSH_TEXT: Record<PushStatus, string> = {
  unsupported: "This browser can't receive push notifications.",
  "needs-install": "On iPhone/iPad, add devin-web to the Home Screen (Share → Add to Home Screen) and open it from there to enable push.",
  denied: "Notifications are blocked for this site — allow them in the browser's site settings.",
  off: "Get a notification when a session needs your input or finishes a turn — even with the tab closed.",
  on: "This device gets a push when a session you aren't looking at needs input or finishes.",
};

function PushControl() {
  const toast = useToast();
  const [st, setSt] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushStatus().then(setSt).catch(() => setSt("unsupported"));
  }, []);
  const run = async (fn: () => Promise<PushStatus>) => {
    setBusy(true);
    try {
      setSt(await fn());
    } catch (e) {
      toast(`Push setup failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <p className="text-2xs text-(--color-faint)">Checking…</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs text-(--color-dim)">{PUSH_TEXT[st]}</p>
      <div className="flex flex-wrap gap-2">
        {st === "off" && (
          <button
            disabled={busy}
            onClick={() => void run(enablePush)}
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-(--color-accent) text-black text-sm font-medium disabled:opacity-40"
          >
            <Bell size={15} /> Enable on this device
          </button>
        )}
        {st === "on" && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void testPush()
                  .then((r) => toast(r.sent ? "Test push sent — lock the screen to see it." : "No device accepted the push.", "info"))
                  .catch((e) => toast((e as Error).message))
              }
              className="px-3 py-2.5 rounded-lg border border-(--color-border2) text-sm text-(--color-text) hover:bg-(--color-panel2)"
            >
              Send test
            </button>
            <button
              disabled={busy}
              onClick={() => void run(disablePush)}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm text-(--color-dim) hover:bg-(--color-panel2) disabled:opacity-40"
            >
              <BellOff size={15} /> Turn off here
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

function SnippetEditor() {
  const toast = useToast();
  const { snippets, loaded, saveSnippets } = useUiPrefs();
  const [draft, setDraft] = useState<Snippet | null>(null);
  const save = async (next: Snippet[]) => {
    try {
      await saveSnippets(next);
    } catch (e) {
      toast(`Couldn't save snippets: ${(e as Error).message}`);
    }
  };
  const commit = async () => {
    if (!draft || !draft.name.trim() || !draft.text.trim()) return;
    const exists = snippets.some((s) => s.id === draft.id);
    await save(exists ? snippets.map((s) => (s.id === draft.id ? draft : s)) : [...snippets, draft]);
    setDraft(null);
  };
  if (!loaded) return <p className="text-2xs text-(--color-faint)">Loading…</p>;
  return (
    <div className="flex flex-col gap-2">
      {snippets.map((s) =>
        draft?.id === s.id ? null : (
          <div key={s.id} className="flex items-start gap-2 rounded-lg border border-(--color-border) bg-(--color-panel2)/50 px-3 py-2">
            <button className="flex-1 min-w-0 text-left" onClick={() => setDraft({ ...s })} title="Edit">
              <div className="text-sm text-(--color-text) truncate">/{s.name}</div>
              <div className="text-2xs text-(--color-dim) line-clamp-2 whitespace-pre-wrap">{s.text}</div>
            </button>
            <button
              onClick={() => void save(snippets.filter((x) => x.id !== s.id))}
              className="p-2 -m-1 rounded text-(--color-faint) hover:text-(--color-danger)"
              aria-label={`Delete snippet ${s.name}`}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ),
      )}
      {draft ? (
        <div className="flex flex-col gap-2 rounded-lg border border-(--color-accent)/40 p-3">
          <input
            autoFocus
            value={draft.name}
            maxLength={60}
            onChange={(e) => setDraft({ ...draft, name: e.target.value.replace(/\s+/g, "-") })}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Escape") setDraft(null);
            }}
            placeholder="name (typed after /)"
            className="bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-base md:text-sm outline-none focus:border-(--color-accent)/60"
          />
          <textarea
            value={draft.text}
            maxLength={8000}
            rows={4}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            placeholder="Prompt text inserted into the composer"
            className="bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-base md:text-sm outline-none focus:border-(--color-accent)/60 resize-y"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setDraft(null)} className="px-3 py-2 rounded-lg text-sm text-(--color-dim)">Cancel</button>
            <button
              onClick={() => void commit()}
              disabled={!draft.name.trim() || !draft.text.trim()}
              className="px-3 py-2 rounded-lg bg-(--color-accent) text-black text-sm font-medium disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setDraft({ id: newId(), name: "", text: "" })}
          className="flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-(--color-border2) text-sm text-(--color-dim) hover:text-white"
        >
          <Plus size={15} /> Add snippet
        </button>
      )}
    </div>
  );
}

function BudgetEditor() {
  const toast = useToast();
  const { budget, loaded, saveBudget } = useUiPrefs();
  const [text, setText] = useState<string | null>(null);
  const value = text ?? (budget ? String(budget.dailyOutputTokens) : "");
  const commit = async () => {
    const n = value.trim() ? parseTokens(value) : null;
    if (value.trim() && !n) return toast("Enter a token count like 200k or 1.5M");
    try {
      await saveBudget(n);
      setText(null);
      toast(n ? `Daily budget set to ${n.toLocaleString()} output tokens` : "Daily budget cleared", "info");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (!loaded) return null;
  return (
    <div className="flex gap-2">
      <input
        inputMode="text"
        value={value}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === "Enter") void commit();
        }}
        placeholder="e.g. 500k (empty = off)"
        className="flex-1 min-w-0 bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-base md:text-sm outline-none focus:border-(--color-accent)/60"
      />
      <button onClick={() => void commit()} className="px-3 py-2 rounded-lg border border-(--color-border2) text-sm hover:bg-(--color-panel2)">
        Save
      </button>
    </div>
  );
}

function AllowRules() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rules, setRules] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<{ allow: string[] }>("/api/permissions")
      .then((r) => setRules(r.allow))
      .catch((e) => setErr((e as Error).message));
  }, []);
  if (err) return <p className="text-2xs text-(--color-faint)">Not available: {err}</p>;
  if (!rules) return <p className="text-2xs text-(--color-faint)">Loading…</p>;
  const shown = rules.filter((r) => r.toLowerCase().includes(q.toLowerCase()));
  const revoke = async () => {
    const list = [...picked];
    if (
      (await confirm({
        title: `Revoke ${list.length} rule(s)?`,
        body: `${list.slice(0, 8).join("\n")}${list.length > 8 ? "\n…" : ""}\n\nDevin will ask again before running these.`,
        confirmLabel: "Revoke",
        danger: true,
      })) !== "confirm"
    )
      return;
    try {
      const r = await api<{ allow: string[] }>("/api/permissions", { method: "DELETE", body: JSON.stringify({ rules: list }) });
      setRules(r.allow);
      setPicked(new Set());
      toast(`Revoked ${list.length} rule(s)`, "info");
    } catch (e) {
      toast(`Revoke failed: ${(e as Error).message}`);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Filter ${rules.length} rules…`}
        className="bg-(--color-panel2) border border-(--color-border) rounded-lg px-3 py-2 text-base md:text-sm outline-none focus:border-(--color-accent)/60"
      />
      <div className="max-h-56 overflow-y-auto rounded-lg border border-(--color-border) divide-y divide-(--color-border)">
        {shown.map((r) => (
          <label key={r} className="flex items-center gap-2.5 px-3 py-2.5 md:py-1.5 text-xs mono cursor-pointer hover:bg-(--color-panel2)">
            <input
              type="checkbox"
              checked={picked.has(r)}
              onChange={() =>
                setPicked((p) => {
                  const n = new Set(p);
                  if (n.has(r)) n.delete(r);
                  else n.add(r);
                  return n;
                })
              }
              className="w-4 h-4 accent-(--color-accent)"
            />
            <span className="break-all">{r}</span>
          </label>
        ))}
        {!shown.length && <p className="px-3 py-3 text-2xs text-(--color-faint)">No rules{q ? " match" : ""}.</p>}
      </div>
      <button
        disabled={!picked.size}
        onClick={() => void revoke()}
        className="self-end flex items-center gap-1.5 px-3 py-2.5 md:py-1.5 rounded-lg border border-(--color-danger)/40 text-(--color-danger) text-sm disabled:opacity-40"
      >
        <ShieldOff size={14} /> Revoke {picked.size || ""}
      </button>
    </div>
  );
}

/** Settings sheet — per-device appearance + notifications, and the
 *  server-synced snippets and budget. A bottom sheet on phones. */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      onClose={onClose}
      label="Settings"
      align="sheet"
      panelClassName="w-full md:max-w-md max-h-[88dvh] overflow-y-auto rounded-t-2xl md:rounded-2xl border border-(--color-border) bg-(--color-panel) px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl"
    >
      <div className="sticky top-0 -mx-4 px-4 pb-2 bg-(--color-panel) flex items-center z-10">
        <div className="md:hidden absolute left-1/2 -translate-x-1/2 -top-1 w-10 h-1 rounded-full bg-(--color-border2)" />
        <h2 className="text-base font-semibold flex-1 pt-2">Settings</h2>
        <button onClick={onClose} className="p-2 -mr-2 mt-1 rounded-lg text-(--color-dim) hover:text-white" aria-label="Close settings">
          <X size={18} />
        </button>
      </div>
      <Section title="Appearance" hint="Saved on this device.">
        <ThemePicker />
      </Section>
      <Section title="Push notifications">
        <PushControl />
      </Section>
      <Section title="Prompt snippets" hint="Synced across devices. Type / in the composer to insert one.">
        <SnippetEditor />
      </Section>
      <Section
        title="Always-allowed commands"
        hint="Rules saved by “Allow always” (devin's user config). A running agent may keep rules it already loaded until it restarts — restart it when idle (devin-web-ctl acpd restart --when-idle) to apply revocations."
      >
        <AllowRules />
      </Section>
      <Section title="Daily token budget" hint="Output tokens across all sessions. You get one warning a day when it's crossed.">
        <BudgetEditor />
      </Section>
    </Modal>
  );
}
