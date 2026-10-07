/** Token/cost usage aggregation — aggregates the usage_rows cache
 *  (lib/searchIndex) + session metadata from sessions.db, read-only.
 *  Per-message model metrics live in `message_nodes.chat_message` →
 *  `metadata.metrics` (input/output/cache tokens, latency); the indexer
 *  flattens them into search.db's usage_rows so report time never touches
 *  message JSON. Per-session totals live in `sessions.metadata` →
 *  total_credit_cost/total_acu_cost. No web-side ledger needed. */
import { openSessionsDb, sessionActivity, hiddenSessionIds } from "./db";
import {
  USAGE_BATCH, indexUsageRows, scheduleCatchup, usageBySession, usageCursor, usageDaily, type UsageSums,
} from "./searchIndex";

export interface SessionUsage {
  sessionId: string;
  title: string | null;
  cwd: string;
  /** assistant responses that carried metrics */
  responses: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costAcu: number;
  costCredit: number;
  /** epoch seconds */
  lastActivity: number | null;
}

export interface UsageReport {
  sessions: SessionUsage[];
  /** per-day token totals, oldest → newest */
  daily: { day: string; inputTokens: number; outputTokens: number }[];
  totals: {
    sessions: number;
    responses: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    costAcu: number;
    costCredit: number;
  };
  /** how far the incremental indexer has walked message_nodes — while
   *  complete is false the token columns are a lower bound, not the truth */
  progress: { indexedRow: number; maxRow: number; complete: boolean };
}

const CACHE_MS = 30_000;
const DAILY_DAYS = 30;
let cache: { at: number; report: UsageReport } | null = null;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface SessionMetaRow {
  id: string;
  title: string | null;
  working_directory: string;
  metadata: string | null;
}

function sessionCosts(meta: string | null): { acu: number; credit: number } {
  if (!meta) return { acu: 0, credit: 0 };
  try {
    const m = JSON.parse(meta) as { total_acu_cost?: unknown; total_credit_cost?: unknown };
    return { acu: num(m.total_acu_cost), credit: num(m.total_credit_cost) };
  } catch {
    return { acu: 0, credit: 0 };
  }
}

export function usageReport(): UsageReport {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.report;
  const empty: UsageReport = {
    sessions: [],
    daily: [],
    totals: { sessions: 0, responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costAcu: 0, costCredit: 0 },
    progress: { indexedRow: 0, maxRow: 0, complete: false },
  };
  try {
    const db = openSessionsDb();
    try {
      // bounded synchronous top-up keeps a warm cache current; a cold one
      // finishes in the background catch-up loop (report says how far)
      indexUsageRows(USAGE_BATCH, db);
      scheduleCatchup();
      const maxRow = (db.prepare("SELECT MAX(row_id) AS m FROM message_nodes").get() as { m: number | null }).m ?? 0;
      const indexedRow = usageCursor();
      const byId = usageBySession() ?? new Map<string, UsageSums>();
      const hidden = hiddenSessionIds(db);
      const act = sessionActivity(db);
      const sRows = db
        .prepare("SELECT id, title, working_directory, metadata FROM sessions")
        .all() as unknown as SessionMetaRow[];

      const sessions: SessionUsage[] = [];
      for (const s of sRows) {
        if (hidden.has(s.id)) continue;
        const u = byId.get(s.id);
        const cost = sessionCosts(s.metadata);
        sessions.push({
          sessionId: s.id,
          title: s.title,
          cwd: s.working_directory,
          responses: u?.responses ?? 0,
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: u?.cacheReadTokens ?? 0,
          cacheCreateTokens: u?.cacheCreateTokens ?? 0,
          costAcu: cost.acu,
          costCredit: cost.credit,
          lastActivity: act.get(s.id) ?? null,
        });
      }
      sessions.sort((a, b) => b.outputTokens - a.outputTokens);
      const daily = usageDaily(Math.floor(Date.now() / 1000) - DAILY_DAYS * 86400) ?? [];

      const totals = {
        sessions: sessions.length,
        responses: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costAcu: 0,
        costCredit: 0,
      };
      for (const s of sessions) {
        totals.responses += s.responses;
        totals.inputTokens += s.inputTokens;
        totals.outputTokens += s.outputTokens;
        totals.cacheReadTokens += s.cacheReadTokens;
        totals.cacheCreateTokens += s.cacheCreateTokens;
        totals.costAcu += s.costAcu;
        totals.costCredit += s.costCredit;
      }

      const report: UsageReport = {
        sessions,
        daily,
        totals,
        progress: { indexedRow, maxRow, complete: indexedRow >= maxRow },
      };
      // only a complete picture is worth caching — a backfilling report
      // should refresh on the next open
      if (report.progress.complete) cache = { at: Date.now(), report };
      return report;
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

/** Test hook — drop the 30s memo. */
export function resetUsageCache() {
  cache = null;
}
