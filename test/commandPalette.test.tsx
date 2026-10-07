// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout — the palette scrolls the selected row into view
Element.prototype.scrollIntoView = vi.fn();

/** pending search responses, keyed by query */
const pending = new Map<string, (v: unknown) => void>();

vi.mock("@/lib/client/api", () => ({
  api: (path: string) =>
    new Promise((resolve) => {
      // F7 appended filter params — pull q out of the real query string
      // rather than assuming it is the only parameter
      pending.set(new URL(path, "http://x").searchParams.get("q") ?? "", resolve);
    }),
}));

import CommandPalette from "../components/CommandPalette";

afterEach(() => {
  cleanup();
  pending.clear();
  vi.useRealTimers();
});

const hit = (title: string) => ({
  results: [{ sessionId: title, title, cwd: "/tmp", snippets: [`about ${title}`] }],
});

describe("CommandPalette search", () => {
  it("ignores a late response for an older query", async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(<CommandPalette sessions={[]} onSelect={() => {}} onNew={() => {}} onClose={() => {}} />);
    });
    // the F7 filter row adds <select>s, which share the combobox role
    const input = screen.getByPlaceholderText(/Jump to session/);
    fireEvent.change(input, { target: { value: "old query" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(input, { target: { value: "new query" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      pending.get("new query")!(hit("NEWER"));
    });
    await act(async () => {
      pending.get("old query")!(hit("OLDER"));
    });
    expect(screen.queryByText("NEWER")).toBeTruthy();
    expect(screen.queryByText("OLDER")).toBeNull();
  });
});
