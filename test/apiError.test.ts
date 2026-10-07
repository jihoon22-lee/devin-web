import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/client/api";
afterEach(() => vi.unstubAllGlobals());
it("preserves recovery metadata on an unsuccessful HTTP response", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "restore failed", undoId: "backup-id" }), { status: 500 })));
  await expect(api("/test-only")).rejects.toMatchObject({ message: "restore failed", body: { undoId: "backup-id" } });
});
