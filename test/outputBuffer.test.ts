import { describe, expect, it } from "vitest";
import { appendOutput, slackFor, tailWithin } from "../lib/acp/outputBuffer.mjs";

const fresh = () => ({ output: "", outputBytes: 0, baseOffset: 0, truncated: false });

describe("appendOutput (R12 B3)", () => {
  it("trims O(bytes/slack) times, not once per chunk", () => {
    const st = fresh();
    const limit = 64 * 1024;
    const chunk = "x".repeat(4096);
    let trims = 0;
    for (let i = 0; i < 200; i++) if (appendOutput(st, chunk, limit)) trims++;
    // 800KB through a 64KB+64KB window → ~11 trims; the old per-chunk path trimmed 184 times
    expect(trims).toBeLessThanOrEqual(13);
    expect(st.outputBytes).toBeLessThanOrEqual(limit + slackFor(limit));
    expect(st.baseOffset + st.outputBytes).toBe(200 * 4096);
    expect(st.truncated).toBe(true);
  });

  it("never splits a multibyte character at the trim edge", () => {
    const st = fresh();
    const limit = 64 * 1024;
    let written = 0;
    for (let i = 0; i < 100; i++) {
      const s = "가나다".repeat(700) + "x"; // odd byte count shifts the cut every chunk
      written += Buffer.byteLength(s);
      appendOutput(st, s, limit);
    }
    expect(st.output).not.toContain("�");
    expect(Buffer.byteLength(st.output)).toBe(st.outputBytes);
    expect(st.baseOffset + st.outputBytes).toBe(written);
  });

  it("tailWithin honours the ACP limit while slack is retained", () => {
    const st = fresh();
    appendOutput(st, "y".repeat(3000), 1024); // 3000 < 1024 + 64K → kept whole
    expect(st.outputBytes).toBe(3000);
    expect(Buffer.byteLength(tailWithin(st, 1024))).toBe(1024);
  });
});
