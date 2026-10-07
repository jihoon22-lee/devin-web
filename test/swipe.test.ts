import { describe, expect, it } from "vitest";
import { EDGE_MAX, EDGE_MIN, swipeAction } from "../lib/client/swipe";

describe("mobile sidebar swipe (L11)", () => {
  it("opens only from the in-page edge band, never the OS back-gesture strip", () => {
    expect(swipeAction({ sx: 10, dx: 120, dy: 5, open: false })).toBeNull();
    expect(swipeAction({ sx: EDGE_MIN, dx: 120, dy: 5, open: false })).toBe("open");
    expect(swipeAction({ sx: EDGE_MAX, dx: 120, dy: 5, open: false })).toBeNull();
  });

  it("closes on a left swipe anywhere while open; ignores short or vertical moves", () => {
    expect(swipeAction({ sx: 300, dx: -120, dy: 10, open: true })).toBe("close");
    expect(swipeAction({ sx: 30, dx: 40, dy: 0, open: false })).toBeNull();
    expect(swipeAction({ sx: 30, dx: 80, dy: 120, open: false })).toBeNull();
  });
});
