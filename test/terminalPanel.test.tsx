// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const { api, sendTerminalInput, dataListeners } = vi.hoisted(() => ({
  api: vi.fn(), sendTerminalInput: vi.fn(), dataListeners: [] as ((s: string) => void)[],
}));
vi.mock("@/lib/client/api", () => ({ api }));
vi.mock("@/lib/client/stream", () => ({ connId: "test", sendTerminalInput,
  streamSub: () => () => {}, onServerRestart: () => () => {},
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  loadAddon() {} open() {} dispose() {} reset() {} write() {}
  onResize() { return { dispose() {} }; }
  onData(cb: (s: string) => void) { dataListeners.push(cb); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
import TerminalPanel from "../components/TerminalPanel";
const terminal = (sessionId: string, id = `term-${sessionId}`) => ({ id, sessionId, label: id, cwd: "/tmp", user: true });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); api.mockReset(); sendTerminalInput.mockReset(); dataListeners.length = 0; });

it("removes A's shell immediately on switch and ignores old xterm input", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const pendingB = deferred<unknown>();
  api.mockImplementation((path: string) => path.includes("sessionId=B") ? pendingB.promise : Promise.resolve({ terminals: [terminal("A")] }));
  const r = render(<TerminalPanel sessionId="A" />);
  await waitFor(() => expect(dataListeners.length).toBe(1));
  const oldInput = dataListeners[0];
  r.rerender(<TerminalPanel sessionId="B" />);
  expect(screen.queryByText("term-A")).toBeNull();
  expect(screen.queryByText("^C")).toBeNull();
  oldInput("danger\n");
  expect(sendTerminalInput).not.toHaveBeenCalled();
});

it("ignores late list and spawn responses from a previous session", async () => {
  const listA = deferred<unknown>(), spawnA = deferred<unknown>();
  api.mockImplementation((path: string, init?: RequestInit) => init?.method === "POST" ? spawnA.promise
    : path.includes("sessionId=A") ? listA.promise : Promise.resolve({ terminals: [] }));
  const r = render(<TerminalPanel sessionId="A" />);
  await act(async () => {});
  fireEvent.click(screen.getByTitle("New shell"));
  r.rerender(<TerminalPanel sessionId="B" />);
  await act(async () => {});
  const requests = api.mock.calls.length;
  await act(async () => {
    listA.resolve({ terminals: [terminal("A")] });
    spawnA.resolve({ terminalId: "spawn-A" });
  });
  expect(screen.queryByText("term-A")).toBeNull();
  expect(screen.queryByText("spawn-A")).toBeNull();
  expect(api.mock.calls.length).toBe(requests);
});
