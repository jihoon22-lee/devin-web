import { describe, expect, it } from "vitest";
import { planTerminalWrite } from "../lib/client/terminalCursor";

describe("planTerminalWrite", () => {
  it("replaces the view for a full snapshot", () => {
    expect(planTerminalWrite(50, { snapshot: "abc", offset: 0, end: 3, partial: false })).toEqual({
      action: { kind: "reset", text: "abc" },
      cursor: 3,
    });
  });

  it("appends a partial snapshot that starts at the cursor", () => {
    expect(planTerminalWrite(8, { snapshot: "WORLD", offset: 8, end: 13, partial: true })).toEqual({
      action: { kind: "append", text: "WORLD" },
      cursor: 13,
    });
  });

  it("skips a partial snapshot the view already has", () => {
    expect(planTerminalWrite(13, { snapshot: "WORLD", offset: 8, end: 13, partial: true })).toEqual({
      action: { kind: "skip" },
      cursor: 13,
    });
  });

  it("appends live data past the cursor and skips replays", () => {
    expect(planTerminalWrite(13, { data: "x", offset: 14 })).toEqual({
      action: { kind: "append", text: "x" },
      cursor: 14,
    });
    expect(planTerminalWrite(14, { data: "x", offset: 14 })).toEqual({ action: { kind: "skip" }, cursor: 14 });
  });

  it("ignores event messages", () => {
    expect(planTerminalWrite(5, { event: { type: "exit" } })).toEqual({ action: { kind: "skip" }, cursor: 5 });
  });
});
