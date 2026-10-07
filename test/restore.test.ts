import { describe, expect, it } from "vitest";
import { blocksToDraft, mergeDraftText } from "../lib/client/restore";

describe("blocksToDraft", () => {
  it("restores full text, images and mentions", () => {
    expect(
      blocksToDraft([
        { type: "resource_link", uri: "file:///tmp/src/a.ts", name: "a.ts" },
        { type: "text", text: "line one\nline two @src/a.ts" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    ).toEqual({
      text: "line one\nline two @src/a.ts",
      images: [{ data: "AAAA", mimeType: "image/png", preview: "data:image/png;base64,AAAA" }],
      mentions: [{ path: "/tmp/src/a.ts", name: "a.ts" }],
    });
  });
});

describe("mergeDraftText", () => {
  it("appends below an existing draft instead of replacing it", () => {
    expect(mergeDraftText("draft", "restored")).toBe("draft\nrestored");
    expect(mergeDraftText("  ", "restored")).toBe("restored");
    expect(mergeDraftText("draft", "")).toBe("draft");
  });
});
