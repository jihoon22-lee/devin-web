import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { dismissNotice } = vi.hoisted(() => ({ dismissNotice: vi.fn() }));
vi.mock("@/lib/state", () => ({ manager: () => ({ dismissNotice }) }));

import { POST } from "../app/api/sessions/[id]/dismiss-notice/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/sessions/s1/dismiss-notice", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "s1" }) },
  );

describe("POST /api/sessions/:id/dismiss-notice", () => {
  it("rejects a missing or non-string id with 400", async () => {
    for (const body of [{}, { id: 7 }, { id: "" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(dismissNotice).not.toHaveBeenCalled();
  });

  it("404s when no notice with that id exists", async () => {
    dismissNotice.mockReturnValue(false);
    const res = await post({ id: "ev-9" });
    expect(res.status).toBe(404);
    expect(dismissNotice).toHaveBeenCalledWith("s1", "ev-9");
  });

  it("dismisses and returns ok", async () => {
    dismissNotice.mockReturnValue(true);
    const res = await post({ id: "ev-3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dismissNotice).toHaveBeenCalledWith("s1", "ev-3");
  });
});
