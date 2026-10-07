/** Theme preference — per device (a phone in sunlight and a desktop at
 *  night want different answers), so localStorage, not ui-state. The
 *  pre-paint copy of this logic lives in THEME_BOOT (layout.tsx). */
export type ThemePref = "system" | "light" | "dark";
const KEY = "dw-theme";
const META = { light: "#f5f6fa", dark: "#090b11" } as const;

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function applyTheme(pref: ThemePref) {
  const t = resolveTheme(pref);
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META[t]);
}

export function saveThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* applies for this page only */
  }
  applyTheme(pref);
}

/** Follow OS light/dark switches while the preference is "system". */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const on = () => {
    if (loadThemePref() === "system") applyTheme("system");
  };
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}

/** Inline pre-paint script: sets data-theme before first paint so a light
 *  device never flashes the dark palette. Mirrors loadThemePref/applyTheme. */
export const THEME_BOOT = `(function(){try{var p=localStorage.getItem("${KEY}");var t=p==="light"||p==="dark"?p:(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"${META.light}":"${META.dark}")}catch(e){}})()`;
