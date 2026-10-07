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
