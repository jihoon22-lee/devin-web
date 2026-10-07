import { describe, expect, it, vi } from "vitest";
import { createSseWriter } from "../lib/stream/sseWriter";

function stream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const rs = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return { rs, ctrl };
}

describe("createSseWriter (R12 B4)", () => {
  it("discards the queued backlog at cutoff instead of draining it first", async () => {
    const { rs, ctrl } = stream();
    const onCutoff = vi.fn();
    const w = createSseWriter(ctrl, { maxPending: 1000, onCutoff });
    let ok = true;
    for (let i = 0; i < 20 && ok; i++) ok = w.write("x".repeat(100));
    expect(ok).toBe(false);
    expect(w.dead).toBe(true);
    expect(onCutoff).toHaveBeenCalledOnce();
    await expect(rs.getReader().read()).rejects.toThrow("slow consumer");
  });

  it("a consumer that keeps reading never trips the cutoff", async () => {
    const { rs, ctrl } = stream();
    const onCutoff = vi.fn();
    const w = createSseWriter(ctrl, { maxPending: 1000, onCutoff });
    const reader = rs.getReader();
    for (let i = 0; i < 50; i++) {
      const read = reader.read(); // pending read → enqueue hands straight to it
      expect(w.write("y".repeat(100))).toBe(true);
      await read;
    }
    expect(onCutoff).not.toHaveBeenCalled();
  });

  it("refuses writes after close", () => {
    const { ctrl } = stream();
    const w = createSseWriter(ctrl, { maxPending: 1000, onCutoff: () => {} });
    w.close();
    expect(w.write("z")).toBe(false);
  });
});
