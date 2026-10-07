import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic state dir — env must be set before lib/* modules are imported.
const stateDir = mkdtempSync(join(tmpdir(), "dw-state-itemlog-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;

/** Counts `INSERT INTO items` runs — the write-amplification regression gate. */
let itemUpserts = 0;
vi.mock("../lib/sqlite", async (importActual) => {
  const real = await importActual<typeof import("../lib/sqlite")>();
  return {
    ...real,
    openDb: (path: string) => {
      const d = real.openDb(path);
      return {
        exec: (sql: string) => d.exec(sql),
        close: () => d.close(),
        prepare: (sql: string) => {
          const st = d.prepare(sql);
          if (!sql.includes("INSERT INTO items")) return st;
          const run = st.run.bind(st);
          return {
            all: st.all.bind(st),
            get: st.get.bind(st),
            run: (...args: unknown[]) => {
              itemUpserts++;
              return run(...args);
            },
          };
        },
      };
    },
  };
});

const { itemLogSave, itemLogDrop, itemLogClearExcept, itemLogRestore, itemLogResetForTests,
  itemLogFinalize, itemLogLoadRetained, itemLogPruneRetained, itemLogForget,
  itemLogSaveMeta, itemLogLoadMeta, itemLogModelMap } =
  await import("../lib/itemLog");
const { openDb } = await import("../lib/sqlite");
import type { AssembledItem } from "../lib/acp/itemAssembler";

const item = (id: string, extra: Partial<AssembledItem> = {}): AssembledItem => ({
  id,
  kind: "text",
  role: "agent",
  text: `text-${id}`,
  done: false,
  seqFrom: 1,
  seqTo: 1,
  ...extra,
});

describe("itemLog", () => {
  it("restores a saved turn's items in order after reopen", () => {
    itemLogSave("s1", "t1", 100, [
      item("p-t1-0", { role: "thought", text: "thinking" }),
      item("p-t1-1", { kind: "tool", tool: { toolCallId: "tc1", title: "Ran x", status: "in_progress" } }),
      item("p-t1-2", { kind: "plan", entries: [{ content: "step", status: "pending" }] }),
      item("p-t1-3", { text: "answer", done: true, seqFrom: 2, seqTo: 4 }),
    ]);
    itemLogResetForTests(); // simulate process restart
    const r = itemLogRestore("s1");
    expect(r?.turnId).toBe("t1");
    expect(r?.startNode).toBe(100);
    expect(r?.ended).toBe(false);
    expect(r?.items.map((i) => i.id)).toEqual(["p-t1-0", "p-t1-1", "p-t1-2", "p-t1-3"]);
    expect(r?.items[1]).toMatchObject({ kind: "tool", tool: { toolCallId: "tc1", status: "in_progress" } });
    expect(r?.items[2]).toMatchObject({ kind: "plan", entries: [{ content: "step" }] });
    expect(r?.items[3]).toMatchObject({ text: "answer", done: true, seqFrom: 2, seqTo: 4 });
  });

  it("dropping a turn removes only that turn's rows", () => {
    itemLogSave("s1", "t1", 10, [item("p-t1-0")]);
    itemLogSave("s1", "t2", 20, [item("p-t2-0", { text: "newer" })]);
    itemLogSave("s2", "t9", 5, [item("p-t9-0")]);
    itemLogDrop("s1", "t1");
    const r = itemLogRestore("s1");
    expect(r?.turnId).toBe("t2"); // newest surviving turn
    expect(r?.items.map((i) => i.id)).toEqual(["p-t2-0"]);
    expect(itemLogRestore("s2")?.items.map((i) => i.id)).toEqual(["p-t9-0"]);
  });

  it("the ended flag persists — a turn closed before its rows are saved", () => {
    // turn_end marks ended at emit time but the save lands on the 40ms
    // flush — the flag must be written by the save itself, not a separate
    // mark that would race ahead of the INSERT
    itemLogSave("s3", "t1", 50, [item("p-t1-0")], true);
    itemLogResetForTests();
    const r = itemLogRestore("s3");
    expect(r?.ended).toBe(true);
    expect(r?.items.map((i) => i.id)).toEqual(["p-t1-0"]);
  });

  it("re-saves only changed items — a 40ms flush must not rewrite the region", () => {
    const items = [
      item("p-t5-0", { role: "thought", text: "thinking" }),
      item("p-t5-1", { kind: "tool", tool: { toolCallId: "tc", title: "x", status: "in_progress" } }),
      item("p-t5-2", { text: "answer" }),
    ];
    itemUpserts = 0;
    itemLogSave("s5", "t5", 10, items);
    expect(itemUpserts).toBe(3); // first save writes everything
    // identical re-flushes (what scheduleProvFlush does all turn long)
    itemLogSave("s5", "t5", 10, items);
    itemLogSave("s5", "t5", 10, items);
    expect(itemUpserts).toBe(3);
    // a single item advancing writes only that row
    itemLogSave("s5", "t5", 10, [
      items[0],
      { ...items[1], seqTo: 9, tool: { toolCallId: "tc", title: "x", status: "completed" } },
      items[2],
    ]);
    expect(itemUpserts).toBe(4);
    // a done-flip alone (finishRole/closeAll bump no seq) is still a change
    itemLogSave("s5", "t5", 10, [
      items[0],
      { ...items[1], seqTo: 9, tool: { toolCallId: "tc", title: "x", status: "completed" }, done: true },
      items[2],
    ]);
    expect(itemUpserts).toBe(5);
    // restore sees the latest content either way
    itemLogResetForTests();
    const r = itemLogRestore("s5");
    expect(r?.items.map((i) => i.id)).toEqual(["p-t5-0", "p-t5-1", "p-t5-2"]);
    expect(r?.items[1]).toMatchObject({ done: true, tool: { status: "completed" } });
  });

  it("a fresh turn re-baselines — clearExcept drops the old signatures", () => {
    itemUpserts = 0;
    itemLogSave("s6", "tA", 10, [item("p-tA-0")]);
    expect(itemUpserts).toBe(1);
    itemLogClearExcept("s6", "tB");
    itemLogSave("s6", "tB", 20, [item("p-tB-0")]);
    expect(itemUpserts).toBe(2); // new turn's first save is a full write
  });

  it("finalize keeps anchored counterpart-less items and drops the spine", () => {
    itemLogSave("s7", "t7", 50, [
      item("p-t7-0", { role: "thought", text: "plan first" }),
      item("p-t7-1", { kind: "tool", tool: { toolCallId: "tc1", title: "x", status: "completed" } }),
      item("p-t7-2", { role: "thought", text: "after tool" }),
      item("p-t7-3", { text: "final answer", done: true }),
    ], true);
    itemLogFinalize("s7", "t7", new Map([["p-t7-0", 50], ["p-t7-2", 61]]));
    const ret = itemLogLoadRetained("s7");
    expect(ret.map((i) => i.id)).toEqual(["p-t7-0", "p-t7-2"]);
    expect(ret[0].anchorNode).toBe(50);
    expect(ret[1].anchorNode).toBe(61);
    // the live-restore path no longer sees this turn
    expect(itemLogRestore("s7")).toBeNull();
  });

  it("persists plan revisions for restart, then strips them at finalize", () => {
    itemLogSave("s11", "t11", 50, [
      item("p-t11-0", {
        kind: "plan",
        entries: [{ content: "step", status: "in_progress" }],
        revisions: [
          { seq: 1, ts: 100, entries: [{ content: "step", status: "pending" }] },
          { seq: 2, ts: 200, entries: [{ content: "step", status: "in_progress" }] },
        ],
      }),
      item("p-t11-1", { role: "thought", text: "after plan" }),
    ], true);
    itemLogResetForTests(); // simulate process restart
    const r = itemLogRestore("s11");
    expect(r?.items[0].revisions).toHaveLength(2);
    expect(r?.items[0].revisions?.[1]).toMatchObject({ seq: 2, ts: 200 });
    // the turn flips: retained items lose the trail — durable todo_write
    // tool rows are the history from here on
    itemLogFinalize("s11", "t11", new Map([["p-t11-0", 50], ["p-t11-1", 55]]));
    const d = openDb(join(stateDir, "itemlog.db"));
    const raw = d
      .prepare("SELECT payload FROM items WHERE session_id = ? AND item_id = ?")
      .get("s11", "p-t11-0") as { payload: string };
    d.close();
    expect(raw.payload).not.toContain("revisions");
    const ret = itemLogLoadRetained("s11");
    expect(ret.map((i) => i.id)).toEqual(["p-t11-0", "p-t11-1"]);
    expect(ret.every((i) => i.revisions === undefined)).toBe(true);
  });

  it("restore skips retained turns but a later live turn still restores", () => {
    itemLogSave("s7", "t8", 100, [item("p-t8-0")]);
    const r = itemLogRestore("s7");
    expect(r?.turnId).toBe("t8");
    expect(itemLogLoadRetained("s7").map((i) => i.id)).toEqual(["p-t7-0", "p-t7-2"]);
  });

  it("clearExcept keeps retained turns but drops dead live turns", () => {
    itemLogSave("s8", "oldDead", 10, [item("p-o-0")]);
    itemLogSave("s8", "kept", 20, [item("p-k-0", { role: "thought" })], true);
    itemLogFinalize("s8", "kept", new Map([["p-k-0", 20]]));
    itemLogClearExcept("s8", "current");
    expect(itemLogLoadRetained("s8").map((i) => i.id)).toEqual(["p-k-0"]);
    expect(itemLogRestore("s8")).toBeNull();
  });

  it("pruneRetained caps retained turns per session, oldest first", () => {
    for (let i = 0; i < 25; i++) {
      itemLogSave("s9", `rt${i}`, i * 10, [item(`p-rt${i}-0`, { role: "thought" })], true);
      itemLogFinalize("s9", `rt${i}`, new Map([[`p-rt${i}-0`, i * 10]]));
    }
    itemLogPruneRetained("s9", 20);
    const ret = itemLogLoadRetained("s9");
    expect(ret.length).toBe(20);
    expect(ret[0].id).toBe("p-rt5-0"); // oldest 5 pruned
  });

  it("migrates a pre-retention schema file in place", () => {
    itemLogResetForTests();
    const d = openDb(join(stateDir, "itemlog.db"));
    d.exec("DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS turns;");
    d.exec(`CREATE TABLE turns(
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      start_node INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id, turn_id))`);
    d.exec(`CREATE TABLE items(
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      ord INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, text TEXT,
      tool TEXT, payload TEXT, done INTEGER NOT NULL,
      seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL,
      PRIMARY KEY(session_id, item_id))`);
    d.close();
    itemLogResetForTests();
    itemLogSave("s10", "t10", 5, [item("p-t10-0", { role: "thought" })], true);
    itemLogFinalize("s10", "t10", new Map([["p-t10-0", 5]]));
    expect(itemLogLoadRetained("s10").map((i) => i.id)).toEqual(["p-t10-0"]);
    expect(itemLogLoadRetained("s10")[0].anchorNode).toBe(5);
  });

  it("a corrupt file opens empty rather than throwing", () => {
    // close BEFORE corrupting — a WAL-mode close checkpoints the wal back
    // over the main file, which would silently "un-corrupt" it
    itemLogResetForTests();
    writeFileSync(join(stateDir, "itemlog.db"), "not a sqlite file");
    rmSync(join(stateDir, "itemlog.db-wal"), { force: true });
    rmSync(join(stateDir, "itemlog.db-shm"), { force: true });
    expect(() => itemLogSave("s4", "t1", 0, [item("p-t1-0")])).not.toThrow();
    expect(itemLogRestore("s4")).toBeNull();
  });
});

describe("itemLogForget (R12 A2)", () => {
  it("removes live and retained turns of one session only", () => {
    itemLogResetForTests();
    process.env.DEVIN_WEB_STATE_DIR = join(stateDir, "forget");
    try {
      const it0 = { id: "p-tA-0", kind: "text" as const, role: "thought" as const, text: "t", done: true, seqFrom: 1, seqTo: 1 };
      itemLogSave("s-forget", "tA", 10, [it0], true);
      itemLogFinalize("s-forget", "tA", new Map([["p-tA-0", 10]]));
      itemLogSave("s-forget", "tB", 20, [{ ...it0, id: "p-tB-0" }], false);
      itemLogSave("s-keep", "tC", 5, [{ ...it0, id: "p-tC-0" }], false);
      itemLogForget("s-forget");
      expect(itemLogLoadRetained("s-forget")).toEqual([]);
      expect(itemLogRestore("s-forget")).toBeNull();
      expect(itemLogRestore("s-keep")?.items.map((i) => i.id)).toEqual(["p-tC-0"]);
    } finally {
      itemLogResetForTests();
      process.env.DEVIN_WEB_STATE_DIR = stateDir;
    }
  });
});

describe("session meta persistence (D V1-2)", () => {
  beforeEach(() => {
    itemLogResetForTests();
    process.env.DEVIN_WEB_STATE_DIR = join(stateDir, "meta");
  });
  afterEach(() => {
    itemLogResetForTests();
    process.env.DEVIN_WEB_STATE_DIR = stateDir;
  });

  it("round-trips, overwrites, and is forgotten with the session", () => {
    itemLogResetForTests();
    expect(itemLogLoadMeta("s-meta")).toBeNull();
    itemLogSaveMeta("s-meta", { title: "A", commands: [{ name: "x" }] });
    itemLogSaveMeta("s-meta", { title: "B", commands: [{ name: "x" }] });
    expect(itemLogLoadMeta("s-meta")).toEqual({ title: "B", commands: [{ name: "x" }] });
    itemLogForget("s-meta");
    expect(itemLogLoadMeta("s-meta")).toBeNull();
  });

  it("a corrupt row reads as absent, never throws", () => {
    itemLogResetForTests();
    itemLogSaveMeta("s-bad", { title: "ok" });
    const d = openDb(join(process.env.DEVIN_WEB_STATE_DIR!, "itemlog.db"));
    d.prepare("UPDATE session_meta SET json = '{' WHERE session_id = 's-bad'").run();
    d.close();
    expect(itemLogLoadMeta("s-bad")).toBeNull();
  });

  it("valid JSON arrays and primitives are not metadata records", () => {
    itemLogResetForTests();
    itemLogSaveMeta("s-array", { title: "ok" });
    itemLogSaveMeta("s-primitive", { title: "ok" });
    const d = openDb(join(process.env.DEVIN_WEB_STATE_DIR!, "itemlog.db"));
    d.prepare("UPDATE session_meta SET json = ? WHERE session_id = ?").run("[]", "s-array");
    d.prepare("UPDATE session_meta SET json = ? WHERE session_id = ?").run('"text"', "s-primitive");
    d.close();
    expect(itemLogLoadMeta("s-array")).toBeNull();
    expect(itemLogLoadMeta("s-primitive")).toBeNull();
  });
});

describe("itemLogModelMap (sidebar model badges)", () => {
  beforeEach(() => {
    itemLogResetForTests();
    process.env.DEVIN_WEB_STATE_DIR = join(stateDir, "models");
  });
  afterEach(() => {
    itemLogResetForTests();
    process.env.DEVIN_WEB_STATE_DIR = stateDir;
  });

  it("maps session_id → the current model's display name", () => {
    itemLogResetForTests();
    itemLogSaveMeta("s-m1", {
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: "default" },
        {
          id: "model", name: "Model", type: "select", currentValue: "claude-opus",
          options: [{ value: "claude-opus", name: "Claude Opus" }],
        },
      ],
    });
    // category match counts as a model option too
    itemLogSaveMeta("s-m2", {
      configOptions: [
        {
          id: "whatever", category: "model", type: "select", currentValue: "gpt-5",
          options: [{ value: "gpt-5", name: "GPT-5" }],
        },
      ],
    });
    // no matching option name → fall back to the raw currentValue
    itemLogSaveMeta("s-m3", {
      configOptions: [{ id: "model", type: "select", currentValue: "custom-build" }],
    });
    // no configOptions at all → absent
    itemLogSaveMeta("s-m4", { title: "plain" });
    const m = itemLogModelMap();
    expect(m.get("s-m1")).toBe("Claude Opus");
    expect(m.get("s-m2")).toBe("GPT-5");
    expect(m.get("s-m3")).toBe("custom-build");
    expect(m.has("s-m4")).toBe(false);
  });

  it("skips corrupt rows and boolean-valued model options without throwing", () => {
    itemLogResetForTests();
    itemLogSaveMeta("s-ok", {
      configOptions: [
        { id: "model", type: "select", currentValue: "v", options: [{ value: "v", name: "V" }] },
      ],
    });
    itemLogSaveMeta("s-corrupt", { title: "x" });
    itemLogSaveMeta("s-bool", {
      configOptions: [{ id: "model", type: "boolean", currentValue: true }],
    });
    const d = openDb(join(process.env.DEVIN_WEB_STATE_DIR!, "itemlog.db"));
    d.prepare("UPDATE session_meta SET json = '{' WHERE session_id = 's-corrupt'").run();
    d.close();
    const m = itemLogModelMap();
    expect(m.get("s-ok")).toBe("V");
    expect(m.has("s-corrupt")).toBe(false);
    expect(m.has("s-bool")).toBe(false);
  });
});
