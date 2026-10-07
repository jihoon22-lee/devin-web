// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Health } from "../lib/client/health";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/api", () => ({ api: vi.fn() }));
vi.mock("../components/Toasts", () => ({ useToast: () => toast }));

import { api } from "@/lib/client/api";
import { HealthBadge } from "../components/SessionSidebar";

const base: Health = {
  uptime: 12,
  attached: 0,
  acp: { alive: true, pid: 42 },
  devin: { version: "3000.11.3", authed: true },
};
const compatible: Health = {
  ...base,
  cliSchema: { ok: true, missing: [], version: 9, status: "compatible" },
};
const drift: Health = {
  ...base,
  cliSchema: { ok: false, missing: ["sessions.main_chain_id"], version: 10, status: "drift" },
};
const unavailable: Health = {
  ...base,
  cliSchema: { ok: false, missing: [], version: null, status: "unavailable" },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(api).mockReset();
  toast.mockReset();
});

async function show(...responses: Health[]) {
  const queue = [...responses];
  vi.mocked(api).mockImplementation((() => Promise.resolve(queue.shift() ?? responses.at(-1))) as typeof api);
  await act(async () => { render(<HealthBadge />); });
}

async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
}

describe("CLI schema health badge (R12 E3)", () => {
  it("keeps an initial mismatch visible without a baseline toast", async () => {
    vi.useFakeTimers();
    await show(drift);
    expect(screen.getByRole("button", { name: "schema" }).getAttribute("title"))
      .toContain("CLI schema mismatch: sessions.main_chain_id (migration 10)");
    expect(toast).not.toHaveBeenCalled();
  });

  it("toasts only on transitions and clears the warning on recovery", async () => {
    vi.useFakeTimers();
    await show(compatible, drift, drift, unavailable, compatible);
    expect(screen.getByRole("button", { name: "acp" })).toBeTruthy();
    await poll();
    expect(toast).toHaveBeenCalledWith("CLI schema mismatch: sessions.main_chain_id");
    expect(screen.getByRole("button", { name: "schema" })).toBeTruthy();
    await poll();
    expect(toast).toHaveBeenCalledTimes(1);
    await poll();
    expect(toast).toHaveBeenCalledWith("CLI schema unavailable: sessions.db could not be read");
    await poll();
    expect(toast).toHaveBeenCalledWith("CLI schema check recovered", "info");
    expect(screen.getByRole("button", { name: "acp" })).toBeTruthy();
  });
});
