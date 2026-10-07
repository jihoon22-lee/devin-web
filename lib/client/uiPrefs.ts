"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Snippet } from "@/lib/uiState";

export type { Snippet };

interface Shared {
  snippets: Snippet[];
  budget: { dailyOutputTokens: number } | null;
}

/** Server-synced preferences (ui-state.json) that several components read:
 *  prompt snippets and the daily token budget. One fetch per page, shared
 *  by every hook instance; writes update all instances at once. */
let shared: Shared | null = null;
let inflight: Promise<Shared> | null = null;
const listeners = new Set<(s: Shared) => void>();

function load(): Promise<Shared> {
  inflight ??= api<{ snippets?: Snippet[]; budget?: { dailyOutputTokens: number } }>("/api/ui-state")
    .then((r) => {
      shared = { snippets: r.snippets ?? [], budget: r.budget ?? null };
      for (const fn of listeners) fn(shared);
      return shared;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function publish(next: Shared) {
  shared = next;
  for (const fn of listeners) fn(next);
}

export function useUiPrefs() {
  const [s, setS] = useState<Shared | null>(shared);
  useEffect(() => {
    listeners.add(setS);
    if (!shared) void load().catch(() => {});
    return () => {
      listeners.delete(setS);
    };
  }, []);
  const saveSnippets = useCallback(async (snippets: Snippet[]) => {
    await api("/api/ui-state", { method: "PUT", body: JSON.stringify({ snippets }) });
    publish({ budget: shared?.budget ?? null, snippets });
  }, []);
  const saveBudget = useCallback(async (dailyOutputTokens: number | null) => {
    const budget = dailyOutputTokens ? { dailyOutputTokens } : null;
    await api("/api/ui-state", { method: "PUT", body: JSON.stringify({ budget }) });
    publish({ snippets: shared?.snippets ?? [], budget });
  }, []);
  return {
    snippets: s?.snippets ?? [],
    budget: s?.budget ?? null,
    loaded: s !== null,
    reload: load,
    saveSnippets,
    saveBudget,
  };
}

/** "200k", "1.5M", "350000" → tokens; null when unparseable/≤0. */
export function parseTokens(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Test hook — forget the shared cache so the next hook mount refetches. */
export function resetUiPrefsForTest() {
  shared = null;
  inflight = null;
}
