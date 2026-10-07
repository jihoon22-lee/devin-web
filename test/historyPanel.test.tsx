// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.fn((path: string) => {
  if (path === "/api/sessions/s1/segments") {
    return Promise.resolve({
      segments: [
        {
          base: 5, tip: 12, startNodeId: 10, count: 3,
          firstPrompt: "new question", startAt: 2000, endAt: 2100,
          isMain: true, kind: "history",
        },
        {
          base: 11, tip: 14, startNodeId: 14, count: 1,
          firstPrompt: "alternate take", startAt: 2050, endAt: 2050,
          isMain: false, kind: "branch",
        },
        {
          base: 0, tip: 3, startNodeId: 1, count: 3,
          firstPrompt: "old hello", startAt: 1000, endAt: 1100,
          isMain: false, kind: "history",
        },
      ],
    });
  }
  return Promise.resolve({});
});
vi.mock("@/lib/client/api", () => ({ api: (p: string) => apiMock(p) }));

import HistoryPanel from "../components/HistoryPanel";

beforeEach(() => {
  cleanup();
  apiMock.mockClear();
});

describe("HistoryPanel", () => {
  it("lists segments with the current one flagged", async () => {
    await act(async () => {
      render(<HistoryPanel sessionId="s1" onOpen={vi.fn()} />);
    });
    expect(apiMock).toHaveBeenCalledWith("/api/sessions/s1/segments");
    expect(screen.getByText("old hello")).toBeTruthy();
    expect(screen.getByText("new question")).toBeTruthy();
    expect(screen.getByText("alternate take")).toBeTruthy();
    const mainCard = screen.getByText("new question").closest("button")!;
    expect(mainCard.textContent).toContain("current");
  });

  it("opens a history segment by its (tip, base) range", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      render(<HistoryPanel sessionId="s1" onOpen={onOpen} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /old hello/i }));
    });
    expect(onOpen).toHaveBeenCalledWith("seg=3&base=0", "old hello");
  });

  it("opens a branch segment through the subtree resolver for context", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      render(<HistoryPanel sessionId="s1" onOpen={onOpen} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /alternate take/i }));
    });
    expect(onOpen).toHaveBeenCalledWith("branch=14", "alternate take");
  });
});
