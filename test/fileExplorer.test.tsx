// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const listings: Record<string, { name: string; path: string; type: string }[]> = {
  "/p": [
    { name: "src", path: "/p/src", type: "dir" },
    { name: "a.txt", path: "/p/a.txt", type: "file" },
  ],
  "/p/src": [{ name: "deep.ts", path: "/p/src/deep.ts", type: "file" }],
};
const apiMock = vi.fn((url: string) => {
  const u = new URL(url, "http://x");
  if (u.pathname === "/api/fs/list") {
    return Promise.resolve({ items: listings[u.searchParams.get("path") ?? ""] ?? [] });
  }
  if (u.pathname === "/api/fs/read") return Promise.resolve({ content: "export {}", encoding: "utf8" });
  return Promise.reject(new Error(`unexpected ${url}`));
});
vi.mock("@/lib/client/api", () => ({ api: (u: string) => apiMock(u) }));

import FileExplorer from "../components/FileExplorer";
import { resetExplorerStateForTest } from "../lib/client/explorerState";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  cleanup();
  apiMock.mockClear();
  resetExplorerStateForTest();
  sessionStorage.clear();
});

describe("FileExplorer keeps its tree (U1)", () => {
  it("back from a file returns to the same expanded tree", async () => {
    await act(async () => {
      render(<FileExplorer cwd="/p" sessionId="s1" />);
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText("src"));
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText("deep.ts"));
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText("back"));
    });
    expect(screen.getByText("deep.ts")).toBeTruthy(); // src is still expanded
  });

  it("switching tabs (unmount → remount) keeps expanded folders, drawn from cache", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<FileExplorer cwd="/p" sessionId="s1" />);
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText("src"));
    });
    await flush();
    view.unmount();
    await act(async () => {
      render(<FileExplorer cwd="/p" sessionId="s1" />);
    });
    expect(screen.getByText("deep.ts")).toBeTruthy(); // no network round-trip needed
  });
});
