import { describe, expect, it } from "vitest";
import { scrollDecision } from "../lib/client/stick";

const VH = 800;

describe("scrollDecision", () => {
  it("reports at-bottom when the gap is under the threshold", () => {
    // scrollTop is the max for scrollHeight 5000
    expect(scrollDecision(4200, 4200, 5000, VH, false).at).toBe(true);
    // small slack (fractional/rounding) still counts
    expect(scrollDecision(4150, 4200, 5000, VH, false).at).toBe(true);
  });

  it("a stale scroll event after content growth does NOT unstick", () => {
    // pinned at 4200 (max for 5000); a new batch grows scrollHeight to 8000 —
    // the queued scroll event sees the same scrollTop but a bigger document.
    // Old behavior treated this as "user scrolled up" and stopped autoscroll.
    const d = scrollDecision(4200, 4200, 8000, VH, false);
    expect(d.at).toBe(false);
    expect(d.unstick).toBe(false);
  });

  it("content-visibility resolving taller rows does NOT unstick", () => {
    // scrollTop unchanged while estimated heights resolve to real ones
    const d = scrollDecision(3000, 3000, 9000, VH, false);
    expect(d.unstick).toBe(false);
  });

  it("scroll anchoring moving scrollTop up WITHOUT input does NOT unstick", () => {
    // rows above the viewport resolve shorter than their 90px estimate → the
    // browser pulls scrollTop up to keep the view stable. No wheel/touch/key
    // accompanied it, so this must not kill the pin (the live bug this fixes:
    // the view froze thousands of px above the bottom mid-load).
    const d = scrollDecision(2000, 4200, 8000, VH, false);
    expect(d.at).toBe(false);
    expect(d.unstick).toBe(false);
  });

  it("an upward scroll WITH user input unsticks", () => {
    const d = scrollDecision(2000, 4200, 8000, VH, true);
    expect(d.at).toBe(false);
    expect(d.unstick).toBe(true);
  });

  it("an upward scroll INSIDE the threshold unsticks (was: swallowed)", () => {
    // pinned at 4200 (max for 5000); user drags up 30px — still within the
    // 60px gap so `at` alone would report bottom and keep snapping back
    // down: the scroll-up/pin fight. Input + upward movement must win.
    const d = scrollDecision(4170, 4200, 5000, VH, true);
    expect(d.at).toBe(false);
    expect(d.unstick).toBe(true);
  });

  it("growth eating gained distance still unsticks while input is fresh", () => {
    // user scrolled up 50px but streaming added 80px of scrollHeight — the
    // gap stayed under 60, so `at` would re-stick mid-gesture.
    const d = scrollDecision(4150, 4200, 5010, VH, true);
    expect(d.unstick).toBe(true);
  });

  it("anchoring masking per-event deltas unsticks via gesture baseline", () => {
    // user drags up on a c-v list; items above resolve taller and anchoring
    // pushes scrollTop back down each event (+12px) — per-event delta looks
    // DOWNWARD, but 20px of net progress from the gesture start is real.
    const d = scrollDecision(4180, 4192, 5000, VH, true, 4200);
    expect(d.unstick).toBe(true);
  });

  it("anchoring fully eating the drag unsticks via accumulated input intent", () => {
    // extreme case: resolution compensation >= finger travel, scrollTop ends
    // ABOVE the gesture start — only the input-side accumulator can tell the
    // user meant to scroll up (35px of upward finger travel).
    const d = scrollDecision(4220, 4210, 5000, VH, true, 4200, 35);
    expect(d.unstick).toBe(true);
  });

  it("small input intent alone does not unstick", () => {
    // 10px of upward intent — below the 30px accumulator threshold
    const d = scrollDecision(4220, 4210, 5000, VH, true, 4200, 10);
    expect(d.unstick).toBe(false);
  });

  it("a downward scroll (pin write / anchor adjust) does NOT unstick", () => {
    const d = scrollDecision(4300, 4200, 8000, VH, true);
    expect(d.unstick).toBe(false);
  });

  it("scrolling back to the bottom re-sticks", () => {
    expect(scrollDecision(7200, 2000, 8000, VH, false).at).toBe(true);
  });

  it("a 1px upward jitter does not unstick", () => {
    expect(scrollDecision(4199.5, 4200, 8000, VH, true).unstick).toBe(false);
  });
});
