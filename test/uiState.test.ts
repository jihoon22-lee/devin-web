import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "dw-ui-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const ui = await import("../lib/uiState");

describe("lib/uiState (E2)", () => {
  it("partial updates dedupe, persist, and survive a module reload", async () => {
    expect(ui.updateUiState({ pins: ["s1", "s1", "s2"] })).toEqual({ pins: ["s1", "s2"], collapsed: [] });
    expect(ui.updateUiState({ collapsed: ["/tmp/a"] })).toEqual({ pins: ["s1", "s2"], collapsed: ["/tmp/a"] });
    vi.resetModules();
    const fresh = await import("../lib/uiState");
    expect(fresh.uiState()).toEqual({ pins: ["s1", "s2"], collapsed: ["/tmp/a"] });
  });

  it("rejects anything but string lists", () => {
    expect(ui.updateUiState({ pins: [1] })).toBeNull();
    expect(ui.updateUiState({ collapsed: "nope" })).toBeNull();
  });

  it("merges sessionDefaults by key and enforces the whitelist", () => {
    expect(ui.updateUiState({ sessionDefaults: { model: "gpt-x" } })?.sessionDefaults).toEqual({
      model: "gpt-x",
    });
    // later writes merge — earlier keys survive
    expect(
      ui.updateUiState({ sessionDefaults: { thought_level: "high", speed: "fast" } })
        ?.sessionDefaults,
    ).toEqual({ model: "gpt-x", thought_level: "high", speed: "fast" });
    expect(ui.uiState().sessionDefaults).toEqual({
      model: "gpt-x",
      thought_level: "high",
      speed: "fast",
    });
  });

  it("rejects non-whitelisted keys and non-string/oversized values", () => {
    expect(ui.updateUiState({ sessionDefaults: { mode: "bypass" } })).toBeNull(); // never Bypass
    expect(ui.updateUiState({ sessionDefaults: { model: "x".repeat(201) } })).toBeNull();
    expect(ui.updateUiState({ sessionDefaults: { model: 3 } })).toBeNull();
    expect(ui.updateUiState({ sessionDefaults: { model: "" } })).toBeNull();
    expect(ui.updateUiState({ sessionDefaults: "nope" })).toBeNull();
    // a rejected patch must not clobber the stored map
    expect(ui.uiState().sessionDefaults?.model).toBe("gpt-x");
  });

  it("stores snippets wholesale and validates every entry", async () => {
    const sn = [{ id: "a", name: " Review ", text: "Review the diff" }, { id: "b", name: "Tests", text: "Run pnpm verify" }];
    expect(ui.updateUiState({ snippets: sn })?.snippets).toEqual([{ ...sn[0], name: "Review" }, sn[1]]);
    expect(ui.updateUiState({ snippets: [{ id: "a", name: "x", text: "" }] })).toBeNull();
    expect(ui.updateUiState({ snippets: [sn[0], sn[0]] })).toBeNull(); // duplicate id
    expect(ui.updateUiState({ snippets: [{ id: "a", name: "n".repeat(61), text: "t" }] })).toBeNull();
    vi.resetModules();
    const fresh = await import("../lib/uiState");
    expect(fresh.uiState().snippets?.map((x) => x.id)).toEqual(["a", "b"]);
    expect(ui.updateUiState({ snippets: [] })?.snippets).toBeUndefined();
  });

  it("sets and clears the daily budget", () => {
    expect(ui.updateUiState({ budget: { dailyOutputTokens: 200000 } })?.budget).toEqual({ dailyOutputTokens: 200000 });
    expect(ui.updateUiState({ budget: { dailyOutputTokens: -1 } })).toBeNull();
    expect(ui.updateUiState({ budget: { dailyOutputTokens: 1.5 } })).toBeNull();
    expect(ui.uiState().budget).toEqual({ dailyOutputTokens: 200000 });
    expect(ui.updateUiState({ budget: null })?.budget).toBeUndefined();
  });
});
