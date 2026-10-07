import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const stateDir = mkdtempSync(join(tmpdir(), "dw-pq-state-"));
process.env.DEVIN_WEB_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const pq = await import("../lib/promptQueue");

const blk = (t: string) => [{ type: "text" as const, text: t }];

describe("lib/promptQueue", () => {
  it("round-trips a queued prompt per session", () => {
    pq.writeSessionQueue("s-a", [{ id: "q-x-1", blocks: blk("hello") }]);
    expect(pq.readAllQueues()["s-a"]).toEqual([{ id: "q-x-1", blocks: blk("hello") }]);
  });

  it("drops the key when the queue empties", () => {
    pq.writeSessionQueue("s-b", [{ id: "q-x-1", blocks: blk("t") }]);
    pq.writeSessionQueue("s-b", []);
    expect(pq.readAllQueues()["s-b"]).toBeUndefined();
  });

  it("keeps unrelated sessions isolated", () => {
    pq.writeSessionQueue("s-c", [{ id: "q-1", blocks: blk("one") }]);
    pq.writeSessionQueue("s-d", [{ id: "q-2", blocks: blk("two") }]);
    pq.writeSessionQueue("s-c", []);
    expect(pq.readAllQueues()["s-d"]?.[0]?.blocks).toEqual(blk("two"));
    pq.writeSessionQueue("s-d", []);
  });

  it("recovers empty on a corrupt file", () => {
    writeFileSync(join(stateDir, "prompt-queue.json"), "{not json");
    expect(pq.readAllQueues()).toEqual({});
  });

  it("drops malformed entries but keeps valid ones", () => {
    writeFileSync(
      join(stateDir, "prompt-queue.json"),
      JSON.stringify({
        good: [{ id: "q-9", blocks: blk("ok") }],
        bad: [{ id: 3 }],
        ugly: "nope",
      }),
    );
    const all = pq.readAllQueues();
    expect(all.good).toEqual([{ id: "q-9", blocks: blk("ok") }]);
    expect(all.bad).toBeUndefined();
    expect(all.ugly).toBeUndefined();
  });

  // above the 512KiB inline threshold in lib/promptQueue
  const bigData = "y".repeat(600 * 1024);
  const qfile = () => join(stateDir, "prompt-queue.json");
  const coldRead = () => {
    const t = new Date(Date.now() + 60_000);
    utimesSync(qfile(), t, t); // force a cold parse past the mtime cache
    return pq.readAllQueues();
  };

  it("offloads large image payloads and keeps the cache returning real data", () => {
    const img = { type: "image" as const, data: bigData, mimeType: "image/png" };
    pq.writeSessionQueue("s-img", [{ id: "q-img-1", blocks: [img] }]);
    const raw = JSON.parse(readFileSync(qfile(), "utf8"));
    const stored = raw["s-img"][0].blocks[0];
    expect(stored.data).toBeUndefined();
    expect(typeof stored.dataBlob).toBe("string");
    expect(readFileSync(join(stateDir, "queue-blobs", stored.dataBlob), "utf8")).toBe(bigData);
    expect(pq.readAllQueues()["s-img"]).toEqual([{ id: "q-img-1", blocks: [img] }]);
    // and again through a cold parse (post-restart path)
    expect(coldRead()["s-img"]).toEqual([{ id: "q-img-1", blocks: [img] }]);
  });

  it("keeps small images inline", () => {
    const img = { type: "image" as const, data: "tiny", mimeType: "image/png" };
    pq.writeSessionQueue("s-small", [{ id: "q-s-1", blocks: [img] }]);
    const raw = JSON.parse(readFileSync(qfile(), "utf8"));
    expect(raw["s-small"][0].blocks[0]).toEqual(img);
    pq.writeSessionQueue("s-small", []);
  });

  it("sweeps blobs no queue references anymore", () => {
    const orphan = join(stateDir, "queue-blobs", "s-orphan--q-orphan-0");
    mkdirSync(join(stateDir, "queue-blobs"), { recursive: true });
    writeFileSync(orphan, bigData);
    pq.writeSessionQueue("s-gc", [{ id: "q-gc-1", blocks: blk("hi") }]);
    expect(existsSync(orphan)).toBe(false);
    // a still-referenced blob survives the sweep; clearing its queue frees it
    const kept = join(stateDir, "queue-blobs", "s-img--q-img-1-0");
    expect(existsSync(kept)).toBe(true);
    pq.writeSessionQueue("s-gc", []);
    pq.writeSessionQueue("s-img", []);
    expect(readdirSync(join(stateDir, "queue-blobs"))).toEqual([]);
  });

  it("drops only the entry whose blob is missing on a cold read", () => {
    writeFileSync(qfile(), JSON.stringify({
      "s-miss": [
        { id: "q-lost", blocks: [{ type: "image", mimeType: "image/png", dataBlob: "gone" }] },
        { id: "q-ok", blocks: blk("still here") },
      ],
    }));
    expect(coldRead()["s-miss"]?.map((e) => e.id)).toEqual(["q-ok"]);
  });
});
