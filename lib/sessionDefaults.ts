// Apply the user's persisted config defaults (ui-state.json sessionDefaults)
// to a freshly created session. Model goes first because thought_level/speed
// option sets depend on the chosen model; the writes that follow are
// validated against the configOptions the model write returned.
// Every failure is swallowed — a bad default must never fail session creation.
import type { SessionConfigOption } from "./acp/types";

type SetOption = (
  configId: string,
  value: string | boolean,
) => Promise<{ configOptions?: SessionConfigOption[] | null } | unknown>;

const ORDER = ["model", "thought_level", "speed"] as const;

export async function applySessionDefaults(
  setOption: SetOption,
  defaults: Record<string, string>,
  /** options from session/new — seeds the "already set / not offered" checks
   *  so defaults that match produce no writes at all */
  current?: SessionConfigOption[] | null,
): Promise<void> {
  let opts = Array.isArray(current) ? current : [];
  const apply = async (key: string) => {
    const v = defaults[key];
    if (typeof v !== "string" || !v) return;
    const opt = opts.find((o) => o.id === key);
    if (!opt) return; // option not offered by this agent
    if (opt.currentValue === v) return; // already the value — skip a no-op write
    if (opt.options && !opt.options.some((o) => o.value === v)) return; // stale default
    try {
      const res = await setOption(opt.id, v);
      // the response's configOptions become the source for the next keys
      const next = (res as { configOptions?: SessionConfigOption[] } | null | undefined)
        ?.configOptions;
      if (Array.isArray(next)) opts = next;
    } catch (e) {
      console.error(`[session-defaults] ${key}=${v} failed:`, e);
    }
  };
  try {
    for (const key of ORDER) await apply(key);
  } catch (e) {
    console.error("[session-defaults] failed:", e);
  }
}
