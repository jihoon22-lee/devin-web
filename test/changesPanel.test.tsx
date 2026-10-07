// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => "confirm" }));
import ChangesPanel from "../components/ChangesPanel";

const listing = (path: string) => ({
  files: [{ path, status: "M", staged: false, unstaged: true, additions: 1, deletions: 1 }],
  branch: "main",
});

afterEach(() => { cleanup(); api.mockReset(); vi.restoreAllMocks(); });

it("disables old file actions immediately when switching sessions", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let finishB!: (value: ReturnType<typeof listing>) => void;
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve({ ok: true });
    if (path.includes("/A/")) return Promise.resolve(listing("old.txt"));
    return new Promise((resolve) => { finishB = resolve; });
  });
  const view = render(<ChangesPanel sessionId="A" />);
  await act(async () => {});
  expect(screen.getByText("old.txt")).toBeTruthy();
  view.rerender(<ChangesPanel sessionId="B" />);
  expect(screen.queryByText("old.txt")).toBeNull();
  expect(screen.queryByTitle("Stage file")).toBeNull();
  await act(async () => finishB(listing("new.txt")));
  fireEvent.click(screen.getByTitle("Stage file"));
  expect(api).toHaveBeenCalledWith("/api/sessions/B/changes", {
    method: "POST", body: JSON.stringify({ action: "stage", file: "new.txt" }),
  });
});

it("ignores a previous session's late listing response", async () => {
  let finishA!: (value: ReturnType<typeof listing>) => void;
  api.mockImplementation((path: string) => path.includes("/A/")
    ? new Promise((resolve) => { finishA = resolve; })
    : Promise.resolve(listing("new.txt")));
  const view = render(<ChangesPanel sessionId="A" />);
  view.rerender(<ChangesPanel sessionId="B" />);
  await act(async () => {});
  await act(async () => finishA(listing("old.txt")));
  expect(screen.queryByText("old.txt")).toBeNull();
  expect(screen.getByText("new.txt")).toBeTruthy();
});

it("turns diff-line comments into one composer prompt", async () => {
  localStorage.clear();
  api.mockImplementation((path: string) =>
    path.includes("?file=")
      ? Promise.resolve({ patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-const n = 30;\n+const n = 60;\n" })
      : Promise.resolve(listing("a.ts")));
  const restored: unknown[] = [];
  const onRestore = (e: Event) => restored.push((e as CustomEvent).detail);
  window.addEventListener("dw-restore", onRestore);
  const onOpenChat = vi.fn();
  render(<ChangesPanel sessionId="R" onOpenChat={onOpenChat} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByText("a.ts")); });
  // the changed word is highlighted on its own
  expect(screen.getByText("60")).toBeTruthy();
  fireEvent.click(screen.getByText("60"));
  fireEvent.change(screen.getByPlaceholderText(/Comment on a.ts:2/), { target: { value: "why 60?" } });
  fireEvent.click(screen.getByText("Add comment"));
  expect(screen.getByText("1 review comment")).toBeTruthy();
  fireEvent.click(screen.getByText("Send to agent"));
  window.removeEventListener("dw-restore", onRestore);
  const text = (restored[0] as { blocks: { text: string }[] }).blocks[0].text;
  expect(text).toContain("a.ts:2 — `const n = 60;`");
  expect(text).toContain("why 60?");
  expect(onOpenChat).toHaveBeenCalled();
  expect(localStorage.getItem("dw-review:R")).toBeNull();
});

it("offers Undo when discard fails after making a safety copy", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.mockImplementation((_path: string, init?: RequestInit) => init?.method === "POST"
    ? Promise.reject(Object.assign(new Error("restore failed"), { body: { undoId: "backup-id" } }))
    : Promise.resolve(listing("file.txt")));
  render(<ChangesPanel sessionId="recovery" />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard changes in file.txt" })); });
  expect(screen.queryByText("Undo revert: file.txt")).not.toBeNull();
});
