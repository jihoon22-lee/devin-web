/** AGENTS.md invariants that aren't pinned by a behavioral test get a
 *  source-level assertion here — cheap guards against silent regressions
 *  of conventions that are invisible until they corrupt state.
 *
 *  Coverage map (behavioral tests live elsewhere):
 *  - fsRoots/pathInRoots → fsRoots.test.ts · literal pathspecs →
 *    gitChanges.test.ts · IME → imeHygiene.test.ts · prompt caps →
 *    limits.test.ts · no ATTACH → db.test.ts · pending-request ids →
 *    pendingRequests.test.ts · adopt/never-reload → manager.test.ts &
 *    daemon.test.ts · stop()-destroys-conns & first-data adoption →
 *    daemon.test.ts · view snapshot/patch ordering → connections.test.ts ·
 *    terminal byte offsets → terminalCursor.test.ts · two-region render →
 *    model.test.ts · index rewrite/meta-wipe rules → indexRewrite.test.ts
 *    & db.test.ts · env isolation → setupEnv.test.ts · _dwDrain single
 *    drain + dropClient unpause → daemon.test.ts · hello-before-first-
 *    response ordering → daemon.test.ts · shimBusy client gate →
 *    idle-restart.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("documented invariants (source assertions)", () => {
  it("applyViewFrame is invoked inside try/catch — a poisoned frame is dropped", () => {
    const s = src("hooks/useSessionView.ts");
    expect(s).toMatch(/try\s*\{[^}]*applyViewFrame\(/);
    expect(s).toMatch(/catch[\s\S]{0,120}diag\("jsrej"/);
  });

  it("ev.data is null-guarded before use", () => {
    expect(src("lib/client/model.ts")).toMatch(/ev\.data\s*\?\?\s*\{\}/);
  });

  it("_meta is never dereferenced without a ?? fallback", () => {
    const s = src("lib/client/model.ts");
    expect(s).not.toMatch(/\._meta\.[a-zA-Z]/); // no direct `_meta.foo`
    expect(s).toMatch(/\._meta\s*\?\?\s*\{\}/);
  });

  it("every transcript item renders inside ItemBoundary", () => {
    const s = src("components/ChatWindow.tsx");
    // the item render path goes through an ItemBoundary wrapper — the
    // window covers the row div's key/id/className prologue
    expect(s).toMatch(/\.map\([\s\S]{0,900}<ItemBoundary>/);
  });

  it("meta wipes are surgical — never a bare DELETE FROM meta", () => {
    // a blanket wipe erases aux_v/indexed_sessions_v and reruns the
    // migration + roster full scans on every boot (R9-2)
    expect(src("lib/searchIndex.ts")).not.toMatch(/DELETE FROM meta(?! WHERE)/);
  });

});
