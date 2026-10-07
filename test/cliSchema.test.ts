import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { checkCliSchema, createCliSchemaHealthReader } from "../lib/cliSchema";
import type { SessionsDb } from "../lib/db";

const schema = readFileSync("test/fixtures/cli-schema/current.sql", "utf8");

function dbFrom(sql = schema): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

describe("CLI sessions.db schema fingerprint (R12 E3)", () => {
  it("accepts the captured schema and reads the latest migration version", () => {
    const db = dbFrom();
    try {
      expect(checkCliSchema(db as unknown as SessionsDb)).toEqual({ ok: true, missing: [], version: null });
      db.exec("INSERT INTO refinery_schema_history(version) VALUES (3), (9)");
      expect(checkCliSchema(db as unknown as SessionsDb).version).toBe(9);
    } finally {
      db.close();
    }
  });

  it("reports the specific missing column and all columns of a missing table", () => {
    const db = dbFrom();
    try {
      db.exec("ALTER TABLE sessions DROP COLUMN main_chain_id");
      expect(checkCliSchema(db as unknown as SessionsDb)).toEqual({
        ok: false,
        missing: ["sessions.main_chain_id"],
        version: null,
      });
      db.exec("DROP TABLE tool_call_state");
      expect(checkCliSchema(db as unknown as SessionsDb).missing).toContain("tool_call_state.tool_call_json");
    } finally {
      db.close();
    }
  });

  it("does not mistake a missing migration table for a schema mismatch", () => {
    const db = dbFrom();
    try {
      db.exec("DROP TABLE refinery_schema_history");
      expect(checkCliSchema(db as unknown as SessionsDb)).toEqual({ ok: true, missing: [], version: null });
    } finally {
      db.close();
    }
  });

  it("caches drift for five minutes and closes every opened handle", () => {
    let now = 1000;
    const dbs: DatabaseSync[] = [];
    const open = vi.fn(() => {
      const db = dbFrom();
      try {
        db.exec("ALTER TABLE sessions DROP COLUMN main_chain_id");
      } catch (error) {
        db.close();
        throw error;
      }
      const close = vi.spyOn(db, "close");
      dbs.push(db);
      return Object.assign(db as unknown as SessionsDb, { close });
    });
    const read = createCliSchemaHealthReader(open, () => now);
    const first = read();
    expect(first).toEqual({ ok: false, missing: ["sessions.main_chain_id"], version: null, status: "drift" });
    now += 299_999;
    expect(read()).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
    now += 1;
    expect(read()).toEqual(first);
    expect(open).toHaveBeenCalledTimes(2);
    expect(dbs.every((db) => vi.mocked(db.close).mock.calls.length === 1)).toBe(true);
  });

  it("marks unreadable databases unavailable, then retries after TTL", () => {
    let now = 0;
    const db = dbFrom();
    const close = vi.spyOn(db, "close");
    const open = vi.fn<() => SessionsDb>()
      .mockImplementationOnce(() => { throw new Error("EACCES"); })
      .mockImplementation(() => db as unknown as SessionsDb);
    const read = createCliSchemaHealthReader(open, () => now);
    try {
      expect(read()).toEqual({ ok: false, missing: [], version: null, status: "unavailable" });
      now = 299_999;
      expect(read().status).toBe("unavailable");
      expect(open).toHaveBeenCalledTimes(1);
      now = 300_000;
      expect(read().status).toBe("compatible");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      if (close.mock.calls.length === 0) db.close();
    }
  });

  it("closes a handle when schema inspection fails", () => {
    const close = vi.fn();
    const open = () => ({
      prepare: () => { throw new Error("SQLITE_IOERR"); },
      close,
    }) as unknown as SessionsDb;
    expect(createCliSchemaHealthReader(open)()).toEqual({
      ok: false, missing: [], version: null, status: "unavailable",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a migration-version read failure as unavailable after column inspection succeeds", () => {
    const db = dbFrom();
    const close = vi.spyOn(db, "close");
    const open = () => ({
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT MAX(version)")) throw new Error("SQLITE_IOERR");
        return db.prepare(sql);
      },
      close: () => db.close(),
    }) as unknown as SessionsDb;
    expect(createCliSchemaHealthReader(open)()).toEqual({
      ok: false, missing: [], version: null, status: "unavailable",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
