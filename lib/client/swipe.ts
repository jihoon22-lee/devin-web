/** Mobile sidebar swipe. The open gesture starts INSIDE the page (24–64px
 *  from the left edge), not at the very edge: iOS Safari and Android gesture
 *  navigation own the first ~20–24px as "back", and this app pushes a
 *  history entry per session switch — an edge swipe would open the sidebar
 *  AND navigate to the previous session. */
export const EDGE_MIN = 24;
export const EDGE_MAX = 64;

export function swipeAction(p: { sx: number; dx: number; dy: number; open: boolean }): "open" | "close" | null {
  if (Math.abs(p.dx) < 60 || Math.abs(p.dy) > Math.abs(p.dx)) return null;
  if (p.dx > 0 && !p.open && p.sx >= EDGE_MIN && p.sx < EDGE_MAX) return "open";
  if (p.dx < 0 && p.open) return "close";
  return null;
}
