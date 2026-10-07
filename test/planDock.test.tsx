// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { ChatItem } from "../lib/client/model";
import type { PlanEntry } from "../lib/acp/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import PlanDock from "../components/PlanDock";

const renderAct = (el: ReactElement) => {
  let r: ReturnType<typeof render>;
  act(() => {
    r = render(el);
  });
  return r!;
};

const E = (content: string, status?: string): PlanEntry => ({ content, status });

const livePlan = (
  entries: PlanEntry[],
  revisions?: { seq: number; ts?: number; entries: PlanEntry[] }[],
): ChatItem => ({ id: "p-turn-0", kind: "plan", entries, revisions });

const SID = "s-dock";

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("PlanDock", () => {
  it("renders a collapsed summary and expands to the checklist", () => {
    localStorage.setItem(`dw-plan-dock:${SID}`, "0"); // persisted collapsed
    const items = [livePlan([E("task a", "in_progress"), E("task b", "pending")])];
    renderAct(<PlanDock items={items} running sessionId={SID} onJump={() => {}} />);

    // collapsed bar: progress + current step, no checklist yet
    expect(screen.getByText("Plan 0/2")).toBeTruthy();
    expect(screen.getByText(/task a/)).toBeTruthy();
    expect(screen.queryByText("task b")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTitle("Expand plan"));
    });
    expect(screen.getByText("task b")).toBeTruthy();
    expect(localStorage.getItem(`dw-plan-dock:${SID}`)).toBe("1");
  });

  it("starts expanded when nothing is stored (fine pointer / no matchMedia)", () => {
    const items = [livePlan([E("task a", "pending")])];
    renderAct(<PlanDock items={items} running sessionId={SID} onJump={() => {}} />);
    expect(screen.getByText("task a")).toBeTruthy(); // checklist visible
  });

  it("lists every revision in History and jumps to the item on click", () => {
    const onJump = vi.fn();
    const items = [
      livePlan([E("a", "completed"), E("b", "in_progress")], [
        { seq: 1, ts: 1_000, entries: [E("a", "in_progress"), E("b", "pending")] },
        { seq: 2, ts: 2_000, entries: [E("a", "completed"), E("b", "in_progress")] },
      ]),
    ];
    renderAct(<PlanDock items={items} running sessionId={SID} onJump={onJump} />);

    act(() => {
      fireEvent.click(screen.getByText("History (2)"));
    });
    const rows = document.querySelectorAll(".dw-plan-row");
    expect(rows).toHaveLength(2);
    act(() => {
      fireEvent.click(rows[0]);
    });
    expect(onJump).toHaveBeenCalledWith("p-turn-0");
  });

  it("hides when idle and every entry reached a terminal state", () => {
    const items = [livePlan([E("a", "completed"), E("b", "failed")])];
    const { container } = renderAct(
      <PlanDock items={items} running={false} sessionId={SID} onJump={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("stays visible when idle while steps remain pending", () => {
    const items = [livePlan([E("a", "completed"), E("b", "pending")])];
    renderAct(<PlanDock items={items} running={false} sessionId={SID} onJump={() => {}} />);
    expect(screen.getByText("Plan 1/2")).toBeTruthy();
  });

  it("renders nothing without plan snapshots", () => {
    const items: ChatItem[] = [
      { id: "bf-1", kind: "text", role: "user", text: "hi", done: true },
    ];
    const { container } = renderAct(
      <PlanDock items={items} running sessionId={SID} onJump={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
