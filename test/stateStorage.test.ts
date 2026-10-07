import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateStorage } from "../lib/stateStorage";

describe("stateStorage", () => {
  it("sums each database with its WAL/SHM and flags nothing small", () => {
    const dir = process.env.DEVIN_WEB_STATE_DIR!;
    writeFileSync(join(dir, "search.db"), Buffer.alloc(1000));
    writeFileSync(join(dir, "search.db-wal"), Buffer.alloc(24));
    writeFileSync(join(dir, "server.log"), "x".repeat(10));
    const s = stateStorage();
    expect(s.files["search.db"]).toBe(1024);
    expect(s.files["server.log"]).toBe(10);
    expect(s.files["itemlog.db"]).toBe(0);
    expect(s.total).toBe(1034);
    expect(s.warn).toEqual([]);
  });
});
