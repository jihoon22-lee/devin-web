// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptySessionState, type SessionState } from "../lib/client/model";
import type { SessionConfigOption } from "../lib/acp/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout — picker scrolls the highlighted row into view
Element.prototype.scrollIntoView = vi.fn();

const setConfig = vi.fn(
  (...args: [string, string, string | boolean]): Promise<unknown> => (
    void args,
    Promise.resolve({})
  ),
);
const apiMock = vi.fn(
  (...args: [string, RequestInit | undefined]): Promise<unknown> => (
    void args,
    Promise.resolve({})
  ),
);

const confirmMock = vi.fn<(o: unknown) => Promise<"confirm" | "alt" | null>>(
  () => Promise.resolve("confirm"),
);
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => confirmMock }));

vi.mock("@/lib/client/api", () => ({
  api: (p: string, i?: RequestInit) => apiMock(p, i),
  setConfig: (s: string, c: string, v: string | boolean) => setConfig(s, c, v),
}));

import ConfigBar from "../components/ConfigBar";
import { ToastProvider } from "../components/Toasts";

const opt = (over: Partial<SessionConfigOption>): SessionConfigOption => ({
  id: "x",
  name: "X",
  type: "select",
  ...over,
});

const configOptions: SessionConfigOption[] = [
  opt({
    id: "mode",
    name: "Mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Default", _meta: { "cognition.ai/icon": "code" } },
      { value: "plan", name: "Plan", _meta: { "cognition.ai/icon": "file-text" } },
      { value: "bypass", name: "Bypass Permissions", _meta: { "cognition.ai/icon": "shield-off" } },
    ],
  }),
  opt({
    id: "model",
    name: "Model",
    currentValue: "gpt-5",
    options: [
      { value: "gpt-5", name: "GPT-5 Codex", _meta: { "cognition.ai/supportsImages": true } },
      { value: "claude-opus", name: "Claude Opus", _meta: { "cognition.ai/supportsImages": false } },
      { value: "fusion-x", name: "Fusion X" },
    ],
  }),
  opt({
    id: "thought_level",
    category: "thought_level",
    name: "Thinking",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Med" },
      { value: "high", name: "High" },
    ],
  }),
  opt({
    id: "speed",
    category: "model_config",
    name: "Speed",
    currentValue: "standard",
    options: [
      { value: "standard", name: "Std" },
      { value: "fast", name: "Fast" },
    ],
  }),
  opt({ id: "autocompact", name: "Auto Compact", type: "boolean", currentValue: false }),
];

const stateWith = (configOptions?: SessionConfigOption[], over: Partial<SessionState> = {}): SessionState => ({
  ...emptySessionState(),
  ...(configOptions ? { configOptions } : {}),
  ...over,
});

const mount = async (state: SessionState) => {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <ToastProvider>
        <ConfigBar sessionId="s1" state={state} />
      </ToastProvider>,
    );
  });
  return utils;
};

beforeEach(() => {
  cleanup();
  setConfig.mockClear();
  setConfig.mockImplementation(() => Promise.resolve({}));
  apiMock.mockClear();
  confirmMock.mockReset().mockResolvedValue("confirm");
  localStorage.clear();
});

describe("ConfigBar", () => {
  it("renders all four option kinds", async () => {
    await mount(stateWith(configOptions));
    expect(screen.getByTitle("Mode")).toBeTruthy();
    expect(screen.getByTitle("Model")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Thinking" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Speed" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Auto Compact" })).toBeTruthy();
  });

  it("mode change calls setConfig and shows the picked value", async () => {
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Plan/ }));
    });
    expect(setConfig).toHaveBeenCalledWith("s1", "mode", "plan");
    expect(screen.getByTitle("Mode").textContent).toContain("Plan");
  });

  it("disables the control while a change is pending and ignores a second set", async () => {
    setConfig.mockReturnValue(new Promise(() => {}));
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Plan/ }));
    });
    const chip = screen.getByTitle("Mode") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toContain("Plan"); // optimistic value
    // a second request for the same option is ignored
    await act(async () => {
      window.dispatchEvent(new CustomEvent("dw-cycle-mode"));
    });
    expect(setConfig).toHaveBeenCalledTimes(1);
  });

  it("rolls back and toasts on failure", async () => {
    setConfig.mockRejectedValueOnce(new Error("denied"));
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Plan/ }));
    });
    await waitFor(() => expect(screen.getByTitle("Mode").textContent).toContain("Default"));
    expect(screen.getByText(/Mode change failed: denied/)).toBeTruthy();
  });

  it("Bypass Permissions asks for confirmation first", async () => {
    confirmMock.mockResolvedValue(null); // dismissed — no switch
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Bypass/ }));
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(setConfig).not.toHaveBeenCalled();
    confirmMock.mockResolvedValue("confirm");
    await act(async () => {
      fireEvent.click(screen.getByTitle("Mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Bypass/ }));
    });
    expect(setConfig).toHaveBeenCalledWith("s1", "mode", "bypass");
  });

  it("model picker filters by search and flags image-less models", async () => {
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Model"));
    });
    const search = screen.getByLabelText("Search models");
    fireEvent.change(search, { target: { value: "claude" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain("Claude Opus");
    expect(screen.getByTitle("no image input")).toBeTruthy();
    // Enter picks the highlighted row
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(setConfig).toHaveBeenCalledWith("s1", "model", "claude-opus");
  });

  it("shows the effort tier encoded in the model value when the name omits it", async () => {
    const opts = configOptions.map((o) =>
      o.id === "model"
        ? { ...o, options: [...(o.options ?? []), { value: "swe-2-high", name: "SWE-2" }] }
        : o,
    );
    await mount(stateWith(opts));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Model"));
    });
    const row = screen
      .getAllByRole("option")
      .find((el) => el.textContent?.includes("SWE-2"));
    expect(row?.textContent).toContain("· high");
    // names that already carry the tier don't get a duplicate tag
    const fusion = screen
      .getAllByRole("option")
      .find((el) => el.textContent?.includes("Fusion X"));
    expect(fusion?.textContent).not.toContain("·");
  });

  it("re-applies the thought level after a model switch reset it", async () => {
    const opts = configOptions.map((o) =>
      o.id === "thought_level" ? { ...o, currentValue: "high" } : o,
    );
    // the model response echoes the new option list — thought reset to its
    // baked-in default but still offers "high"
    setConfig.mockImplementation((_s: string, c: string) =>
      Promise.resolve(
        c === "model"
          ? {
              configOptions: opts.map((o) =>
                o.id === "thought_level" ? { ...o, currentValue: "medium" } : o,
              ),
            }
          : {},
      ),
    );
    await mount(stateWith(opts));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Model"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Claude Opus/ }));
    });
    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith("s1", "thought_level", "high"),
    );
  });

  it("re-applies other selects (e.g. speed) that a model switch reset", async () => {
    const opts = configOptions.map((o) =>
      o.id === "speed" ? { ...o, currentValue: "fast" } : o,
    );
    setConfig.mockImplementation((_s: string, c: string) =>
      Promise.resolve(
        c === "model"
          ? {
              configOptions: opts.map((o) =>
                o.id === "speed" ? { ...o, currentValue: "standard" } : o,
              ),
            }
          : {},
      ),
    );
    await mount(stateWith(opts));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Model"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Claude Opus/ }));
    });
    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith("s1", "speed", "fast"),
    );
  });

  it("does not re-apply a thought level the new model no longer offers", async () => {
    const opts = configOptions.map((o) =>
      o.id === "thought_level" ? { ...o, currentValue: "xhigh" } : o,
    );
    setConfig.mockImplementation((_s: string, c: string) =>
      Promise.resolve(
        c === "model"
          ? {
              configOptions: opts.map((o) =>
                o.id === "thought_level" ? { ...o, currentValue: "medium" } : o,
              ),
            }
          : {},
      ),
    );
    await mount(stateWith(opts));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Model"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Claude Opus/ }));
    });
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith("s1", "model", "claude-opus"));
    // give any follow-up a tick — none should fire (xhigh isn't offered)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(setConfig).toHaveBeenCalledTimes(1);
  });

  it("treats an error body in a 200 response as a failure", async () => {
    setConfig.mockResolvedValueOnce({ error: "Invalid params" });
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Plan/ }));
    });
    await waitFor(() =>
      expect(screen.getByText(/Mode change failed: Invalid params/)).toBeTruthy(),
    );
    expect(screen.getByTitle("Mode").textContent).toContain("Default");
  });

  it("dw-open-model-picker opens the model popover", async () => {
    await mount(stateWith(configOptions));
    expect(screen.queryByLabelText("Search models")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("dw-open-model-picker"));
    });
    expect(screen.getByLabelText("Search models")).toBeTruthy();
  });

  it("thought segment applies a picked level and re-renders on configOptions change", async () => {
    const utils = await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "High" }));
    });
    expect(setConfig).toHaveBeenCalledWith("s1", "thought_level", "high");
    // agent replies with a different option set (per-model lists)
    const next = configOptions.map((o) =>
      o.id === "thought_level"
        ? {
            ...o,
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "xhigh", name: "XHigh" },
            ],
          }
        : o,
    );
    await act(async () => {
      utils.rerender(
        <ToastProvider>
          <ConfigBar sessionId="s1" state={stateWith(next)} />
        </ToastProvider>,
      );
    });
    expect(screen.getByRole("button", { name: "XHigh" })).toBeTruthy();
  });

  it("persists model/thought/speed defaults after a successful change", async () => {
    await mount(stateWith(configOptions));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "High" }));
    });
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/ui-state",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    expect(JSON.parse(apiMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      sessionDefaults: { thought_level: "high" },
    });
  });

  it("queued count still renders in the row", async () => {
    await mount(stateWith(configOptions, { queued: 3 }));
    // the badge renders in both the <md summary row and the desktop row —
    // jsdom has no layout so both subtrees are in the DOM
    expect(screen.getAllByText("+3 queued").length).toBeGreaterThan(0);
  });
});
