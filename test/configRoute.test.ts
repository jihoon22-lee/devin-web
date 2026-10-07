import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { setConfigOption } = vi.hoisted(() => ({
  setConfigOption: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/state", () => ({ manager: () => ({ setConfigOption }) }));
import { POST } from "../app/api/sessions/[id]/config/route";

const post = (body: string) =>
  POST(new NextRequest("http://localhost/api/sessions/test/config", { method: "POST", body }), {
    params: Promise.resolve({ id: "test" }),
  });

describe("POST /api/sessions/:id/config validation", () => {
  it("rejects a malformed body with 400", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-string configId with 400", async () => {
    for (const body of [{ value: "x" }, { configId: 7, value: "x" }, { configId: "", value: "x" }]) {
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a string or boolean with 400", async () => {
    for (const value of [42, { v: 1 }, [true], null]) {
      const res = await post(JSON.stringify({ configId: "mode", value }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("forwards a valid {configId, value} to the manager and returns its result", async () => {
    const res = await post(JSON.stringify({ configId: "mode", value: "code" }));
    expect(res.status).toBe(200);
    expect(setConfigOption).toHaveBeenCalledWith("test", "mode", "code");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts boolean values", async () => {
    const res = await post(JSON.stringify({ configId: "verbose", value: true }));
    expect(res.status).toBe(200);
    expect(setConfigOption).toHaveBeenCalledWith("test", "verbose", true);
  });
});
