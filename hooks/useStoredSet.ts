"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";

/** Pins / collapsed groups: server truth (`/api/ui-state`, shared across
 *  devices) with a localStorage mirror for instant first paint and offline.
 *  A device holding local values while the server is empty uploads once. */
export function useStoredSet(key: "dw-pins" | "dw-collapsed"): [Set<string>, (fn: (s: Set<string>) => Set<string>) => void] {
  const field = key === "dw-pins" ? "pins" : "collapsed";
  const [set, setSet] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    const local = (): string[] => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
      } catch {
        return [];
      }
    };
    // deferred: synchronous setState in an effect body causes a double render
    queueMicrotask(() => setSet(new Set(local())));
    api<{ pins: string[]; collapsed: string[] }>("/api/ui-state")
      .then((s) => {
        if (cancelled) return;
        const server = s[field];
        const mine = local();
        if (!server.length && mine.length) {
          void api("/api/ui-state", { method: "PUT", body: JSON.stringify({ [field]: mine }) }).catch(() => {});
          return;
        }
        setSet(new Set(server));
        try {
          localStorage.setItem(key, JSON.stringify(server));
        } catch {
          /* quota/ignore */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, field]);
  const update = (fn: (s: Set<string>) => Set<string>) => {
    setSet((prev) => {
      const next = fn(prev);
      const arr = [...next];
      try {
        localStorage.setItem(key, JSON.stringify(arr));
      } catch {
        /* quota/ignore */
      }
      void api("/api/ui-state", { method: "PUT", body: JSON.stringify({ [field]: arr }) }).catch(() => {});
      return next;
    });
  };
  return [set, update];
}
