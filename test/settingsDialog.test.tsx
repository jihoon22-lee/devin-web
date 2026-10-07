// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => () => Promise.resolve("confirm") }));
vi.mock("@/lib/client/push", () => ({
  pushStatus: () => Promise.resolve("off"),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  testPush: vi.fn(),
}));

import SettingsDialog from "../components/SettingsDialog";
import { ToastProvider } from "../components/Toasts";
import { resetUiPrefsForTest } from "../lib/client/uiPrefs";

afterEach(() => {
  cleanup();
  api.mockReset();
  resetUiPrefsForTest();
  delete document.documentElement.dataset.theme;
});

window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as typeof window.matchMedia;

const mount = async () => {
  await act(async () => {
    render(
      <ToastProvider>
        <SettingsDialog onClose={() => {}} />
      </ToastProvider>,
    );
  });
};

describe("SettingsDialog", () => {
  it("switches the theme on the document and remembers it", async () => {
    api.mockResolvedValue({ allow: [], pins: [], collapsed: [] });
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("dw-theme")).toBe("light");
    fireEvent.click(screen.getByRole("radio", { name: /System/ }));
    expect(localStorage.getItem("dw-theme")).toBeNull();
  });

  it("revokes picked allow-always rules", async () => {
    api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/permissions" && init?.method === "DELETE") return Promise.resolve({ allow: ["Exec(ls)"] });
      if (path === "/api/permissions") return Promise.resolve({ allow: ["Exec(ls)", "Exec(rm)"] });
      return Promise.resolve({ pins: [], collapsed: [] });
    });
    await mount();
    fireEvent.click(screen.getByText("Exec(rm)"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Revoke 1/ }));
    });
    expect(api).toHaveBeenCalledWith("/api/permissions", { method: "DELETE", body: JSON.stringify({ rules: ["Exec(rm)"] }) });
    expect(screen.queryByText("Exec(rm)")).toBeNull();
  });
});
