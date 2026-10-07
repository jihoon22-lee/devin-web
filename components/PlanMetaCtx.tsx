"use client";

import { createContext } from "react";
import type { PlanEntry } from "@/lib/acp/types";

export interface PlanMeta {
  /** itemId → the snapshot entries immediately preceding that card's latest
   *  snapshot (null when there is none) — PlanUpdateCard diffs against this
   *  for its transition chips */
  diffs: Map<string, PlanEntry[] | null>;
  /** the newest plan snapshot's item — its card defaults to expanded */
  latestPlanItemId?: string;
}

export const PlanMetaCtx = createContext<PlanMeta | null>(null);

/** Header "Expand all thoughts" toggle — when true, every thought block
 *  renders open regardless of its own collapsed state. */
export const ThoughtExpandCtx = createContext(false);
