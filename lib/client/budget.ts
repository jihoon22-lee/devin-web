/** Daily output-token budget check — pure so it is testable. `today` is
 *  the local YYYY-MM-DD (sessions.db usage buckets by server localtime;
 *  the server is this user's machine). */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function budgetState(
  daily: { day: string; outputTokens: number }[],
  budget: number | null | undefined,
  today = localDay(),
): { used: number; budget: number; over: boolean; ratio: number } | null {
  if (!budget) return null;
  const used = daily.find((d) => d.day === today)?.outputTokens ?? 0;
  return { used, budget, over: used >= budget, ratio: Math.min(1, used / budget) };
}
