// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ResizablePanel from "../components/ResizablePanel";
import { PANEL_DEFAULT, PANEL_MIN, clampPanelWidth } from "../lib/client/panelWidth";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

const widthOf = () =>
  screen.getByRole("separator").parentElement!.style.getPropertyValue("--dw-panel-w");

describe("clampPanelWidth", () => {
  it("keeps 320px for the chat and 240px for the panel", () => {
    expect(clampPanelWidth(100, 1400)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, 1400)).toBe(1080);
    expect(clampPanelWidth(500, 400)).toBe(PANEL_MIN); // tiny window: the panel minimum wins
  });
});

describe("ResizablePanel", () => {
  it("arrow keys resize and persist per tab; double-click resets", async () => {
    await act(async () => {
      render(<ResizablePanel tab="files"><div>content</div></ResizablePanel>);
    });
    expect(widthOf()).toBe(`${PANEL_DEFAULT.files}px`);
    await act(async () => {
      // the panel docks right — its handle sits on the left edge, so
      // ArrowLeft widens (moves the edge left) and ArrowRight narrows
      fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    });
    expect(widthOf()).toBe(`${PANEL_DEFAULT.files + 16}px`);
    expect(localStorage.getItem("dw-panel-width:files")).toBe(String(PANEL_DEFAULT.files + 16));
    await act(async () => {
      fireEvent.doubleClick(screen.getByRole("separator"));
    });
    expect(widthOf()).toBe(`${PANEL_DEFAULT.files}px`);
  });

  it("each tab remembers its own width", async () => {
    localStorage.setItem("dw-panel-width:changes", "380");
    await act(async () => {
      render(<ResizablePanel tab="changes"><div /></ResizablePanel>);
    });
    expect(widthOf()).toBe("380px");
  });
});
