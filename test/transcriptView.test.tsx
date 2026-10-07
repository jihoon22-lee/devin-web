// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api }));
vi.mock("@/lib/client/stream", () => ({ streamSub: () => () => {}, onStreamState: () => () => {} }));
vi.mock("../components/Markdown", () => ({ default: ({ children }: { children: string }) => children }));
vi.mock("../components/MessageItem", () => ({ ToolCard: () => null }));
vi.mock("@/hooks/useStickToBottom", () => ({ useStickToBottom: () => ({
  scrollRef: { current: null }, onScroll: () => {}, atBottom: true, jumpToBottom: () => {}, unpin: () => {},
}) }));
import TranscriptView from "../components/TranscriptView";
const recent = { id: 1001, role: "assistant", text: "recent", ts: 1 };
afterEach(() => { cleanup(); vi.useRealTimers(); api.mockReset(); });

it("keeps older-history pagination after empty and nonempty incremental refreshes", async () => {
  vi.useFakeTimers();
  api.mockImplementation((path: string) => Promise.resolve(path.includes("?before=")
    ? { items: [{ ...recent, id: 1, text: "oldest" }], truncated: false }
    : path.includes("?after=") ? { items: [], truncated: false }
      : { items: [recent], truncated: true }));
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => {});
  expect(screen.queryByText("Load earlier messages")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(screen.queryByText("Load earlier messages")).not.toBeNull();
  api.mockResolvedValueOnce({ items: [{ ...recent, id: 1002, text: "newest" }], truncated: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(screen.queryByText("Load earlier messages")).not.toBeNull();
  expect(screen.getByText("newest")).toBeTruthy();
  fireEvent.click(screen.getByText("Load earlier messages"));
  await act(async () => {});
  expect(screen.getByText("oldest")).toBeTruthy();
  expect(screen.queryByText("Load earlier messages")).toBeNull();
});

it("replaces the pagination flag when a full reset replaces the history window", async () => {
  vi.useFakeTimers();
  api.mockResolvedValueOnce({ items: [recent], truncated: true })
    .mockResolvedValue({ items: [recent], truncated: false, reset: true });
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => {});
  expect(screen.queryByText("Load earlier messages")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(screen.queryByText("Load earlier messages")).toBeNull();
});

const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((r, f) => { resolve = r; reject = f; }); return { promise, resolve, reject }; };
it.each(["initial", "delta", "older"])("ignores late %s responses after session change, including cursor", async (kind) => {
  vi.useFakeTimers();
  const old = deferred<unknown>();
  api.mockImplementation((path: string) => {
    if (path.includes("/A/") && (kind === "initial" || path.includes(kind === "delta" ? "?after=" : "?before="))) return old.promise;
    return Promise.resolve({ items: [{ ...recent, id: path.includes("/A/") ? 100 : 10, text: path.includes("/A/") ? "A baseline" : "B baseline" }], truncated: path.includes("/A/") });
  });
  const r = render(<TranscriptView session={{ sessionId: "A", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => {});
  if (kind === "delta") await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  if (kind === "older") fireEvent.click(screen.getByText("Load earlier messages"));
  r.rerender(<TranscriptView session={{ sessionId: "B", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => {});
  await act(async () => { old.resolve({ items: [{ ...recent, id: 9000, text: "stale A" }], truncated: true }); });
  expect(screen.queryByText("stale A")).toBeNull();
  expect(screen.queryByText("Load earlier messages")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(api.mock.calls.at(-1)?.[0]).toBe("/api/sessions/B/transcript?after=10");
});

it("does not show errors from the previous session", async () => {
  const old = deferred<unknown>();
  api.mockImplementation((path: string) => path.includes("/A/") ? old.promise : Promise.resolve({ items: [recent], truncated: false }));
  const r = render(<TranscriptView session={{ sessionId: "A", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => {});
  r.rerender(<TranscriptView session={{ sessionId: "B", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => { old.reject(new Error("A failed")); });
  expect(screen.queryByText("A failed")).toBeNull();
});

it("pages to the exact search node instead of matching repeated text", async () => {
  vi.useFakeTimers();
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  api.mockImplementation((path: string) => Promise.resolve(path.includes("?before=")
    ? { items: [{ ...recent, id: 5, text: "same prefix old" }], truncated: false }
    : { items: [{ ...recent, id: 100, text: "same prefix new" }], truncated: true }));
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} jump={{ nodeId: 5, anchor: "same prefix", n: 1 }} onRetry={() => {}} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(api.mock.calls.some(([p]) => p.includes("?before=100"))).toBe(true);
  expect(scroll.mock.instances.map((el) => (el as HTMLElement).id)).toEqual(["msg-5"]);
});

it("reports a missing authoritative node without flashing a text match", async () => {
  vi.useFakeTimers();
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  api.mockResolvedValue({ items: [{ ...recent, text: "same prefix new" }], truncated: false });
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} jump={{ nodeId: 5, anchor: "same prefix", n: 1 }} onRetry={() => {}} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(scroll).not.toHaveBeenCalled();
  expect(screen.queryByText(/Search result not found/)).not.toBeNull();
});

it("bounds search paging at twenty pages", async () => {
  let before = 100;
  api.mockImplementation((path: string) => Promise.resolve({ items: [{ ...recent, id: path.includes("?before=") ? --before : before }], truncated: true }));
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} jump={{ nodeId: 1, n: 1 }} onRetry={() => {}} />);
  await act(async () => {});
  expect(api.mock.calls.filter(([p]) => p.includes("?before=")).length).toBe(20);
  expect(screen.queryByText(/Search result not found/)).not.toBeNull();
});

it("cancels old search paging on a new target and ignores its eventual response", async () => {
  const old = deferred<unknown>();
  api.mockImplementation((path: string) => path.includes("?before=") ? old.promise : Promise.resolve({ items: [{ ...recent, id: 100 }], truncated: true }));
  const r = render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} jump={{ nodeId: 5, n: 1 }} onRetry={() => {}} />);
  await act(async () => {});
  const signal = api.mock.calls.find(([p]) => p.includes("?before="))?.[1]?.signal as AbortSignal;
  r.rerender(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} jump={{ nodeId: 100, n: 2 }} onRetry={() => {}} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { old.resolve({ items: [{ ...recent, id: 5, text: "obsolete target" }], truncated: false }); });
  expect(screen.queryByText("obsolete target")).toBeNull();
});

it("discards older-page responses from a replaced baseline and resets its cursor", async () => {
  vi.useFakeTimers();
  const old = deferred<unknown>();
  api.mockResolvedValueOnce({ items: [{ ...recent, id: 100 }], truncated: true })
    .mockImplementation((path: string) => path.includes("?before=") ? old.promise : Promise.resolve({ items: [{ ...recent, id: 10, text: "reset window" }], truncated: false, reset: true }));
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} onRetry={() => {}} />);
  await act(async () => {});
  fireEvent.click(screen.getByText("Load earlier messages"));
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  await act(async () => { old.resolve({ items: [{ ...recent, id: 50, text: "stale page" }], truncated: true }); });
  expect(screen.queryByText("stale page")).toBeNull();
  expect(screen.queryByText("Load earlier messages")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(api.mock.calls.at(-1)?.[0]).toBe("/api/sessions/s/transcript?after=10");
});

it.each(["empty", "error"])("stops search paging after an %s page instead of repeating the same request", async (kind) => {
  api.mockImplementation((path: string) => !path.includes("?before=")
    ? Promise.resolve({ items: [recent], truncated: true })
    : kind === "error" ? Promise.reject(new Error("page failed")) : Promise.resolve({ items: [], truncated: true }));
  render(<TranscriptView session={{ sessionId: "s", cwd: "/tmp" }} jump={{ nodeId: 1, n: 1 }} onRetry={() => {}} />);
  await act(async () => {});
  expect(api.mock.calls.filter(([p]) => p.includes("?before=")).length).toBe(1);
  expect(screen.queryByText(/Search result not found/)).not.toBeNull();
});
