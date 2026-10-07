// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/client/api", () => ({
  api: vi.fn(() =>
    Promise.resolve({
      uptime: 600,
      attached: 2,
      host: true,
      acp: { alive: true, pid: 42, via: "daemon", degraded: null },
      stream: { connections: 2, live: 1, subs: 5 },
      view: { sessions: 3 },
      devin: { version: "3000.1.2", authed: true },
      cliSchema: { ok: false, missing: ["sessions.main_chain_id"], version: 12, status: "drift" },
    }),
  ),
}));

import DiagnosticsDialog from "../components/DiagnosticsDialog";

describe("DiagnosticsDialog (E5)", () => {
  it("shows session view count, streams and agent state from /api/health", async () => {
    await act(async () => {
      render(<DiagnosticsDialog onClose={() => {}} />);
    });
    expect(screen.getByText("1/2 live · 5 subs")).toBeTruthy();
    expect(screen.getByText("session views")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // view sessions
    expect(screen.getByText("running · pid 42 · daemon")).toBeTruthy();
    expect(screen.getByText("MISMATCH · sessions.main_chain_id · migration 12")).toBeTruthy();
  });
});
