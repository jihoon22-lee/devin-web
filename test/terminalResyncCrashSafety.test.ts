// A terminal sub resyncs by RPC-ing the daemon for a snapshot. While the
// host socket is down (acpd restart, daemon respawn) that RPC rejects —
// and the web process installs no unhandledRejection handler of its own,
// so an uncaught one here is a full server outage, not a dropped frame.
import { expect, it, vi } from "vitest";
vi.mock("@/lib/acp/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/acp/terminal")>();
  return {
    ...orig,
    terminalPool: {
      // exactly what RemoteTerminalPool does when the daemon is restarting
      snapshot: async () => { throw new Error("host rpc term/snapshot timed out"); },
      attach: async () => { throw new Error("host socket closed"); },
      detach: async () => {},
      dropConnState: async () => {},
      onResync: () => () => {},
    },
  };
});
const { attachStream, subscribe } = await import("../lib/stream/connections");

it("survives a rejected terminal snapshot while the host is restarting", async () => {
  const rejections: unknown[] = [];
  const on = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", on);
  try {
    attachStream("tc1", 0, () => true);
    subscribe("tc1", [{ kind: "terminal", id: "term-1" }]);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", on);
  }
  expect(rejections).toEqual([]);
});
