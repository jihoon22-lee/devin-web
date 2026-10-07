// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.fn((path: string) => {
  const p = decodeURIComponent(path.split("path=")[1] ?? "");
  if (p === "~") return Promise.resolve({ path: "/home/u", parent: "/home", items: [] });
  if (p === "~/proj") return Promise.resolve({ path: "/home/u/proj", parent: "/home/u", items: [] });
  return Promise.reject(new Error("ENOENT: no such file or directory"));
});

vi.mock("@/lib/client/api", () => ({ api: (p: string) => apiMock(p) }));

import DirectoryPicker from "../components/DirectoryPicker";

beforeEach(() => {
  cleanup();
  apiMock.mockClear();
});

const mount = async (onPick = vi.fn()) => {
  await act(async () => {
    render(<DirectoryPicker onPick={onPick} onClose={() => {}} />);
  });
  return onPick;
};

describe("DirectoryPicker", () => {
  it("Select resolves a typed ~ path before creating the session", async () => {
    const onPick = await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "~/proj" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Select"));
    });
    expect(onPick).toHaveBeenCalledWith("/home/u/proj");
  });

  it("Select refuses a directory that does not exist", async () => {
    const onPick = await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/nope" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Select"));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText(/Cannot use \/nope/)).toBeTruthy();
  });

  it("Enter during an IME composition does not navigate", async () => {
    await mount();
    expect(apiMock).toHaveBeenCalledTimes(1); // initial listing
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 229 });
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
