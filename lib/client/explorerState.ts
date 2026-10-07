/** Files-tab UI state that must outlive the tree component (U1). Opening a
 *  file used to UNMOUNT the tree — every DirNode's own useState reset, so
 *  "back" showed a fully collapsed tree — and switching tabs did the same.
 *  Kept per explorer root for the page's lifetime and mirrored to
 *  sessionStorage, so a mobile tab reload (backgrounded tab discarded)
 *  keeps it too. Directory listings are cached so a remount renders the
 *  expanded tree synchronously — the scroll restore needs the height at once. */
export interface ExplorerItem {
  name: string;
  path: string;
  type: string;
}

export interface ExplorerState {
  /** absolute paths of expanded directories (the root is always open) */
  expanded: string[];
  /** tree scroll offset, saved when the tree hides or unmounts */
  scrollTop: number;
  /** last opened file — highlighted in the tree after "back" */
  lastFile: string | null;
}

const states = new Map<string, ExplorerState>();
const listings = new Map<string, ExplorerItem[]>();
const storageKey = (root: string) => `dw-explorer:${root}`;

export function loadExplorerState(root: string): ExplorerState {
  const hit = states.get(root);
  if (hit) return hit;
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(root)) ?? "null") as Partial<ExplorerState> | null;
    if (raw && Array.isArray(raw.expanded)) {
      const s: ExplorerState = {
        expanded: raw.expanded.filter((p): p is string => typeof p === "string"),
        scrollTop: typeof raw.scrollTop === "number" ? raw.scrollTop : 0,
        lastFile: typeof raw.lastFile === "string" ? raw.lastFile : null,
      };
      states.set(root, s);
      return s;
    }
  } catch {
    /* storage unavailable or corrupt — start fresh */
  }
  return { expanded: [], scrollTop: 0, lastFile: null };
}

export function saveExplorerState(root: string, s: ExplorerState) {
  states.set(root, s);
  try {
    sessionStorage.setItem(storageKey(root), JSON.stringify(s));
  } catch {
    /* quota — the in-memory copy still works */
  }
}

export function toggleExpanded(s: ExplorerState, path: string): ExplorerState {
  return s.expanded.includes(path)
    ? { ...s, expanded: s.expanded.filter((p) => p !== path) }
    : { ...s, expanded: [...s.expanded, path] };
}

export const cachedListing = (dir: string): ExplorerItem[] | null => listings.get(dir) ?? null;

export function cacheListing(dir: string, items: ExplorerItem[]) {
  listings.set(dir, items);
}

/** Test hook. */
export function resetExplorerStateForTest() {
  states.clear();
  listings.clear();
}
