/** Server-side counter for client `integrity` beacons — the transcript's
 *  regression alarm. Route files can't export non-HTTP symbols (Next.js
 *  route export validation), so the counter lives here: the diag route
 *  increments it, the health route reads it. Module-scope state is
 *  per-process — a web restart resets it, which is fine: the alarm's job
 *  is "did it happen since the last deploy". */
let integrity = { total: 0, lastAt: null as number | null, lastSig: null as string | null };

export function noteIntegrityBeacon(sig: string) {
  integrity = { total: integrity.total + 1, lastAt: Date.now(), lastSig: sig };
}

export function integrityCount() {
  return { ...integrity };
}
