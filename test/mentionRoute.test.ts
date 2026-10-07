import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { prompt } = vi.hoisted(() => ({ prompt: vi.fn().mockResolvedValue({ queued: false }) }));
vi.mock("@/lib/state", () => ({ manager: () => ({ prompt }) }));
import { POST } from "../app/api/sessions/[id]/prompt/route";

describe("R12 C6 prompt resource links", () => {
  it("encodes file paths at the API boundary and preserves the display name", async () => {
    const res = await POST(new NextRequest("http://localhost/api/sessions/test/prompt", {
      method: "POST", body: JSON.stringify({ text: "read this", mentions: [{ path: "/tmp/dw mention/a #1.txt", name: "a #1.txt" }] }),
    }), { params: Promise.resolve({ id: "test" }) });
    expect(res.status).toBe(200);
    expect(prompt).toHaveBeenCalledWith("test", [
      { type: "resource_link", uri: "file:///tmp/dw%20mention/a%20%231.txt", name: "a #1.txt" },
      { type: "text", text: "read this" },
    ]);
  });
});
