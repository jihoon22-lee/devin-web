import { describe, expect, it } from "vitest";
import { LineDecoder, encodeMessage } from "../lib/acp/ndjson";

describe("LineDecoder", () => {
  it("decodes complete lines", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(d.pending).toBe("");
  });

  it("handles messages split across chunks", () => {
    const d = new LineDecoder();
    expect(d.push('{"jsonrpc":"2.0","id":')).toEqual([]);
    expect(d.push('1,"result":{}}\n')).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  it("handles multiple messages in one chunk", () => {
    const d = new LineDecoder();
    const out = d.push('{"m":1}\n{"m":2}\n{"m":3}\n{"m"');
    expect(out).toHaveLength(3);
    expect(d.pending).toBe('{"m"');
  });

  it("strips CR and skips blank lines", () => {
    const d = new LineDecoder();
    expect(d.push("\n\r\n{a:1}\r\n\n")).toEqual(["{a:1}"]);
  });

  it("decodes a large burst without losing lines (offset-scan path)", () => {
    const d = new LineDecoder();
    const burst = Array.from({ length: 5000 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    const out = d.push(burst);
    expect(out).toHaveLength(5000);
    expect(out[0]).toBe('{"n":0}');
    expect(out[4999]).toBe('{"n":4999}');
    expect(d.pending).toBe("");
    // remainder after the burst still decodes
    expect(d.push('{"n":5000}\n')).toEqual(['{"n":5000}']);
  });
});

describe("encodeMessage", () => {
  it("produces newline-terminated JSON", () => {
    const s = encodeMessage({ jsonrpc: "2.0", id: 1, method: "session/list" });
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s)).toMatchObject({ method: "session/list" });
  });
});
