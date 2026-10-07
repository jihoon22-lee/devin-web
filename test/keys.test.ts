import { describe, expect, it } from "vitest";
import { isImeComposing } from "../lib/client/keys";

describe("isImeComposing", () => {
  it("is true while a React keydown is part of an IME composition", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
  });
  it("is true for the Safari/legacy composition keyCode 229", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });
  it("accepts native KeyboardEvent-shaped objects", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });
  it("is false for a plain Enter", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  });
});
