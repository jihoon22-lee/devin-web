// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptySessionState, type SessionState } from "../lib/client/model";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const sendPrompt = vi.fn((...args: unknown[]) => (void args, Promise.resolve({})));
const cancelPrompt = vi.fn((...args: unknown[]) => (void args, Promise.resolve({})));
const setConfig = vi.fn((...args: unknown[]) => (void args, Promise.resolve({})));

const confirmMock = vi.fn<(o: unknown) => Promise<"confirm" | "alt" | null>>(
  () => Promise.resolve("confirm"),
);
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => confirmMock }));

vi.mock("@/lib/client/api", () => ({
  api: vi.fn(() => Promise.resolve({ prompts: [] })),
  sendPrompt: (...a: unknown[]) => sendPrompt(...a),
  cancelPrompt: (...a: unknown[]) => cancelPrompt(...a),
  setConfig: (...a: unknown[]) => setConfig(...a),
}));

import ChatInput from "../components/ChatInput";
import { api } from "@/lib/client/api";
import { resetUiPrefsForTest } from "../lib/client/uiPrefs";

const running = (over: Partial<SessionState> = {}): SessionState => ({
  ...emptySessionState(),
  running: true,
  ...over,
});

const mount = async (state: SessionState) => {
  await act(async () => {
    render(<ChatInput sessionId="s1" cwd="/tmp" state={state} />);
  });
};

beforeEach(() => {
  cleanup();
  sendPrompt.mockClear();
  cancelPrompt.mockClear();
  setConfig.mockClear();
  confirmMock.mockReset().mockResolvedValue("confirm");
  localStorage.clear();
  // a touch device: Enter inserts a newline, so buttons are the only way to send
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as typeof window.matchMedia;
});

describe("ChatInput while a turn is running", () => {
  it("offers Stop and Queue message; queueing sends the prompt", async () => {
    await mount(running());
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "next step" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    });
    expect(sendPrompt).toHaveBeenCalledWith("s1", "next step", undefined, undefined);
  });

  it("Stop asks whether to drop queued prompts and forwards the answer", async () => {
    await mount(running({ queued: 2 }));
    // "Stop only" keeps the queue
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(cancelPrompt).toHaveBeenCalledWith("s1", false);
    // "Stop & drop" clears it
    confirmMock.mockResolvedValue("alt");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(cancelPrompt).toHaveBeenCalledWith("s1", true);
    // dismissing the dialog leaves the turn running
    confirmMock.mockResolvedValue(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(cancelPrompt).toHaveBeenCalledTimes(2);
  });

  it("Stop without a queue does not ask", async () => {
    await mount(running());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(cancelPrompt).toHaveBeenCalledWith("s1", false);
  });
});

describe("ChatInput restore (edit a queued prompt)", () => {
  it("merges the queued prompt's text, images and mentions into the draft", async () => {
    await mount(running());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("dw-restore", {
          detail: {
            sessionId: "s1",
            blocks: [
              { type: "text", text: "line one\nline two @src/a.ts" },
              { type: "resource_link", uri: "file:///tmp/src/a.ts", name: "a.ts" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
          },
        }),
      );
    });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toBe("draft\nline one\nline two @src/a.ts");
    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    });
    expect(sendPrompt).toHaveBeenCalledWith(
      "s1",
      "draft\nline one\nline two @src/a.ts",
      [{ data: "AAAA", mimeType: "image/png" }],
      [{ path: "/tmp/src/a.ts", name: "a.ts" }],
    );
  });

  it("ignores restores meant for another session", async () => {
    await mount(running());
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("dw-restore", {
          detail: { sessionId: "other", blocks: [{ type: "text", text: "nope" }] },
        }),
      );
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("revokes attachment previews when the composer unmounts", async () => {
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview-1"), revokeObjectURL: revoke });
    await mount(emptySessionState());
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    // FileReader.onload is genuinely async — a single macrotask tick loses
    // the race under load (the preview hadn't rendered yet and the revoke
    // assertion below then failed spuriously). Wait for the preview itself.
    await waitFor(() => expect(document.querySelectorAll("img").length).toBe(1));

    cleanup(); // unmount

    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });
});

describe("composer autosize", () => {
  // jsdom reports scrollHeight 0 / "normal" lineHeight, so this only pins
  // that autosize ran (inline height + overflow control), not real growth
  it("applies an inline height and hides overflow below the cap", async () => {
    await mount(emptySessionState());
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.style.height).not.toBe("");
    expect(ta.style.overflowY).toBe("hidden");
    fireEvent.change(ta, { target: { value: "line one\nline two" } });
    await waitFor(() => expect(ta.style.height).not.toBe(""));
  });
});

describe("Shift+Tab mode cycling", () => {
  const withModes = (current: string): SessionState => ({
    ...emptySessionState(),
    running: true,
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: current,
        options: [
          { value: "default", name: "Default" },
          { value: "plan", name: "Plan" },
          { value: "bypass", name: "Bypass Permissions" },
        ],
      },
    ],
  });

  it("cycles to the next option in order", async () => {
    await mount(withModes("default"));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab", shiftKey: true });
    });
    expect(setConfig).toHaveBeenCalledWith("s1", "mode", "plan");
  });

  it("never cycles into bypass", async () => {
    await mount(withModes("plan")); // next would be bypass → wraps to default
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab", shiftKey: true });
    });
    expect(setConfig).toHaveBeenCalledWith("s1", "mode", "default");
  });

  it("does not cycle during IME composition", async () => {
    await mount(withModes("default"));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), {
        key: "Tab",
        shiftKey: true,
        keyCode: 229, // Safari reports isComposing=false on the committing keydown
      });
    });
    expect(setConfig).not.toHaveBeenCalled();
  });
});

describe("composer across sessions and snippets", () => {
  it("flushes the outgoing session's draft immediately on a switch", async () => {
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<ChatInput sessionId="s1" cwd="/tmp" state={emptySessionState()} />);
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half-typed" } });
    // switch before the 250ms debounce would have saved it
    await act(async () => {
      r.rerender(<ChatInput sessionId="s2" cwd="/tmp" state={emptySessionState()} />);
    });
    expect(localStorage.getItem("dw-draft-s1")).toBe("half-typed");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    await act(async () => {
      r.rerender(<ChatInput sessionId="s1" cwd="/tmp" state={emptySessionState()} />);
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("half-typed");
  });

  it("offers saved snippets in the / palette and inserts their text", async () => {
    resetUiPrefsForTest();
    vi.mocked(api).mockImplementation(((path: string) =>
      Promise.resolve(
        path === "/api/ui-state"
          ? { pins: [], collapsed: [], snippets: [{ id: "a", name: "review", text: "Please review the diff" }] }
          : { prompts: [] },
      )) as typeof api);
    await mount(emptySessionState());
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    // the palette reads the previous render's text — type in two steps
    for (const v of ["/re", "/rev"]) {
      await act(async () => {
        fireEvent.change(ta, { target: { value: v } });
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      });
    }
    const item = await screen.findByText("/review");
    await act(async () => {
      fireEvent.mouseDown(item);
    });
    expect(ta.value).toBe("Please review the diff");
    vi.mocked(api).mockImplementation((() => Promise.resolve({ prompts: [] })) as unknown as typeof api);
    resetUiPrefsForTest();
  });
});
