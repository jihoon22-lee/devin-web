// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/client/api", () => ({ api: vi.fn(() => new Promise(() => {})) }));

import { api } from "@/lib/client/api";
import SessionSidebar from "../components/SessionSidebar";

const noop = () => {};

afterEach(cleanup);

describe("SessionSidebar", () => {
  it("marks sessions whose automatic re-attach failed", async () => {
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[{ sessionId: "s1", cwd: "/tmp", title: "Broken", attachFailed: true }]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    expect(screen.getByTitle(/Could not re-attach/)).toBeTruthy();
  });

  it("keeps project groups in fixed alphabetical order regardless of activity", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SessionSidebar
          sessions={[
            // /b-dir has the newer session — groups must still sort by path
            { sessionId: "s-new", cwd: "/b-dir", title: "newer", updatedAt: "2026-09-19T10:00:00Z" },
            { sessionId: "s-old", cwd: "/a-dir", title: "older", updatedAt: "2026-09-18T10:00:00Z" },
          ]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      ));
    });
    // group headers carry title={dir} — document order must be alphabetical
    const dirs = [...container.querySelectorAll("[title]")]
      .map((el) => el.getAttribute("title")!)
      .filter((t) => /^\/[ab]-dir$/.test(t));
    expect(dirs).toEqual(["/a-dir", "/b-dir"]);
  });

  it("needs-input toggle filters to sessions with pending requests", async () => {
    const sessions = [
      { sessionId: "s-wait", cwd: "/tmp", title: "Waiting", pendingRequests: 1 },
      { sessionId: "s-idle", cwd: "/tmp", title: "Idle" },
    ];
    await act(async () => {
      render(
        <SessionSidebar
          sessions={sessions}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    // badge marker on the pending row
    expect(screen.getByTitle(/Waiting for input/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Only sessions waiting for input"));
    });
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.queryByText("Idle")).toBeNull();
  });

  it("renders tag chips and matches them in the filter", async () => {
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[{ sessionId: "s1", cwd: "/tmp", title: "Tagged", tags: ["backend", "urgent"] }]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    expect(screen.getByText("#backend")).toBeTruthy();
    expect(screen.getByText("#urgent")).toBeTruthy();

    // tag text is searchable through the session filter
    const input = screen.getByPlaceholderText("Filter sessions…");
    await act(async () => {
      fireEvent.change(input, { target: { value: "urgent" } });
    });
    expect(screen.getByText("Tagged")).toBeTruthy();
    await act(async () => {
      fireEvent.change(input, { target: { value: "zzz" } });
    });
    expect(screen.queryByText("Tagged")).toBeNull();
  });

  it("Enter during an IME composition does not save tags", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[{ sessionId: "s1", cwd: "/tmp", title: "Tagged" }]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    fireEvent.contextMenu(screen.getByText("Tagged"));
    await act(async () => {
      fireEvent.click(screen.getByText("Edit tags…"));
    });
    const input = screen.getByPlaceholderText("comma-separated tags…");
    fireEvent.change(input, { target: { value: "작업" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 }); // committing a Hangul syllable
    });
    expect(apiMock.mock.calls.some(([p]) => String(p).endsWith("/tags"))).toBe(false);
  });

  it("uploads this device's local pins once when the server has none", async () => {
    localStorage.setItem("dw-pins", JSON.stringify(["s1"]));
    const apiMock = vi.mocked(api);
    apiMock.mockImplementation(((path: string, init?: RequestInit) =>
      path === "/api/ui-state" && !init
        ? Promise.resolve({ pins: [], collapsed: [] })
        : new Promise(() => {})) as never);
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[{ sessionId: "s1", cwd: "/tmp", title: "Pinned here" }]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const put = apiMock.mock.calls.find(
      ([p, i]) => p === "/api/ui-state" && (i as RequestInit | undefined)?.method === "PUT",
    );
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ pins: ["s1"] });
    apiMock.mockImplementation((() => new Promise(() => {})) as never);
    localStorage.clear();
  });

  it("Alt+↓ / Alt+↑ walk sessions in on-screen order", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[
            { sessionId: "a1", cwd: "/a", title: "A-new", updatedAt: "2026-09-19T10:00:00Z" },
            { sessionId: "a2", cwd: "/a", title: "A-old", updatedAt: "2026-09-18T10:00:00Z" },
            { sessionId: "b1", cwd: "/b", title: "B", updatedAt: "2026-09-19T11:00:00Z" },
          ]}
          selected="a2"
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={onSelect}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "b1" }));
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "a1" }));
  });

  it("groups worktree sessions under the source repo and shows the branch chip", async () => {
    let container: HTMLElement | undefined;
    await act(async () => {
      const r = render(
        <SessionSidebar
          sessions={[
            { sessionId: "main-1", cwd: "/repo/app", title: "main session" },
            {
              sessionId: "wt-1",
              cwd: "/home/u/.local/state/devin-web/worktrees/app-x1",
              title: "isolated session",
              worktree: { branch: "devin-web/app-x1", repo: "/repo/app" },
            },
          ]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
      container = r.container;
    });
    // one group — the repo; the worktrees/ path must not appear as a group
    expect(container!.querySelectorAll('[class*="group/dir"]').length).toBe(1);
    expect(screen.getByTitle(/Isolated worktree: devin-web\/app-x1/)).toBeTruthy();
    expect(screen.getByText("app-x1")).toBeTruthy();
  });

  it("keeps archived sessions out of the groups until the Archived section opens", async () => {
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[
            { sessionId: "live-1", cwd: "/p", title: "live session" },
            { sessionId: "old-1", cwd: "/p", title: "parked session", archived: true },
          ]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    // active list has only the live session; the parked one is collapsed away
    expect(screen.getByText("live session")).toBeTruthy();
    expect(screen.queryByText("parked session")).toBeNull();
    expect(screen.getByText("Archived")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Archived"));
    });
    expect(screen.getByText("parked session")).toBeTruthy();
  });

  it("offers Archive / Unarchive in the row menu and PUTs the flag", async () => {
    await act(async () => {
      render(
        <SessionSidebar
          sessions={[
            { sessionId: "live-1", cwd: "/p", title: "live session" },
            { sessionId: "old-1", cwd: "/p", title: "parked session", archived: true },
          ]}
          selected={null}
          unread={new Set()}
          open
          onToggle={noop}
          onHome={noop}
          onSelect={noop}
          onNew={noop}
          onNewInDir={noop}
          onDelete={noop}
          onTakeover={noop}
          onPalette={noop}
          onRefresh={noop}
          onCleanup={noop}
        />,
      );
    });
    const row = screen.getByText("live session").closest("div")!;
    await act(async () => {
      fireEvent.contextMenu(row);
    });
    expect(screen.getByText("Archive")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      "/api/sessions/live-1/archive",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ archived: true }) }),
    );
  });

});

describe("SessionSidebar round-17 behaviour", () => {
  const base = {
    selected: null, unread: new Set<string>(), open: true, onToggle: noop, onHome: noop, onNew: noop,
    onNewInDir: noop, onDelete: noop, onTakeover: noop, onPalette: noop, onRefresh: noop, onCleanup: noop,
  };
  const two = [
    { sessionId: "a", cwd: "/home/u/proj", title: "**Bold** title", model: "SWE-2" },
    { sessionId: "b", cwd: "/home/u/proj", title: "Other", model: "SWE-2" },
    { sessionId: "c", cwd: "/home/u/proj", title: "Odd one", model: "Opus" },
  ];

  it("keeps the ~/ prefix in order inside the rtl-clipped group label", async () => {
    await act(async () => {
      render(<SessionSidebar {...base} sessions={two} onSelect={noop} />);
    });
    expect(screen.getByText((t) => t.includes("~/proj")).textContent).toBe("‎~/proj‎");
  });

  it("cleans titles and labels only the model that differs from the group", async () => {
    await act(async () => {
      render(<SessionSidebar {...base} sessions={two} onSelect={noop} />);
    });
    expect(screen.getByText("Bold title")).toBeTruthy();
    expect(screen.queryByText("SWE-2")).toBeNull();
    expect(screen.getByText("Opus")).toBeTruthy();
  });

  it("lets a modified click open the session in a new tab", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      render(<SessionSidebar {...base} sessions={two} onSelect={onSelect} />);
    });
    const link = screen.getByText("Other");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("distinguishes loading, empty and filtered-out lists", async () => {
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<SessionSidebar {...base} sessions={[]} loaded={false} onSelect={noop} />);
    });
    expect(screen.getByLabelText("Loading sessions")).toBeTruthy();
    await act(async () => {
      r.rerender(<SessionSidebar {...base} sessions={[]} loaded onSelect={noop} />);
    });
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
    await act(async () => {
      r.rerender(<SessionSidebar {...base} sessions={two} loaded onSelect={noop} />);
    });
    fireEvent.change(screen.getByPlaceholderText("Filter sessions…"), { target: { value: "zzz" } });
    expect(screen.getByText(/No sessions match "zzz"/)).toBeTruthy();
    fireEvent.click(screen.getByText("Clear filter"));
    expect(screen.getByText("Other")).toBeTruthy();
  });

  it("selection mode toggles rows instead of opening them and bulk-deletes", async () => {
    const onSelect = vi.fn();
    const onDeleteMany = vi.fn(() => Promise.resolve());
    await act(async () => {
      render(<SessionSidebar {...base} sessions={two} onSelect={onSelect} onDeleteMany={onDeleteMany} />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));
    fireEvent.click(screen.getByText("Other"));
    fireEvent.click(screen.getByText("Odd one"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("2 selected")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    });
    expect(onDeleteMany).toHaveBeenCalledWith([expect.objectContaining({ sessionId: "b" }), expect.objectContaining({ sessionId: "c" })]);
  });
});
