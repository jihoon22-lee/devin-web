import { describe, expect, it } from "vitest";
import { blocksBytes, queueText, queueView } from "../lib/acp/queuePreview";

describe("queue previews", () => {
  it("previews the first line with mention names and attachment markers", () => {
    expect(queueText([{ type: "text", text: "fix it\nmore" }])).toBe("fix it");
    expect(
      queueView({
        queue: [{
          id: "q-1",
          mentionEncoding: "uri",
          blocks: [
            { type: "text", text: "look" },
            { type: "resource_link", uri: "file:///tmp/a%20b.ts", name: "a b.ts" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        }],
      }),
    ).toEqual([{ id: "q-1", text: "look @a b.ts [attachment]", mentions: [{ path: "/tmp/a b.ts", name: "a b.ts" }], attachments: 1 }]);
  });

  it("sizes blocks by string length without serializing", () => {
    expect(blocksBytes([{ type: "text", text: "x".repeat(100) }, { type: "image", data: "y".repeat(1000), mimeType: "image/png" }])).toBe(64 * 2 + 1100);
  });
});
