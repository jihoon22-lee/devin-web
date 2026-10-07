/** Side-panel widths. Per tab AND per device: reading a file wants
 *  width, a changes list doesn't, and monitors differ — so localStorage,
 *  not the server. */
export type PanelTab = "files" | "changes" | "terminal" | "history" | "plan";

export const PANEL_DEFAULT: Record<PanelTab, number> = {
  files: 560,
  changes: 440,
  terminal: 640,
  history: 420,
  plan: 420,
};
export const PANEL_MIN = 240;
/** the chat column never shrinks below this */
export const CHAT_MIN = 320;
const KEY = "dw-panel-width:";

export function clampPanelWidth(w: number, containerWidth: number): number {
  const max = Math.max(PANEL_MIN, containerWidth - CHAT_MIN);
  return Math.round(Math.min(max, Math.max(PANEL_MIN, w)));
}

export function loadPanelWidth(tab: PanelTab): number {
  try {
    const v = Number(localStorage.getItem(KEY + tab));
    return Number.isFinite(v) && v >= PANEL_MIN ? v : PANEL_DEFAULT[tab];
  } catch {
    return PANEL_DEFAULT[tab]; // no storage (SSR / privacy mode)
  }
}

export function savePanelWidth(tab: PanelTab, w: number) {
  try {
    localStorage.setItem(KEY + tab, String(Math.round(w)));
  } catch {
    /* quota — the width still applies for this view */
  }
}
