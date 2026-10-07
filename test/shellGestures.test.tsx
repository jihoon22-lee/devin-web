// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";
import { useGlobalShortcuts } from "../hooks/useShellGestures";

describe("useGlobalShortcuts (F2)", () => {
  it("? toggles the help outside text fields; Ctrl+K opens the palette", () => {
    const onPalette = vi.fn();
    const onShortcuts = vi.fn();
    renderHook(() => useGlobalShortcuts({ onPalette, onShortcuts }));

    fireEvent.keyDown(window, { key: "?" });
    expect(onShortcuts).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "?" }); // typing a literal "?"
    expect(onShortcuts).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(onPalette).toHaveBeenCalledTimes(1);
    input.remove();
  });
});
