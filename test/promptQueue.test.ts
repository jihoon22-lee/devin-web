import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

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

  const quarantined = () => readdirSync(stateDir).filter((n) => n.startsWith("prompt-queue.json.corrupt-"));
  const clearQuarantine = () => { for (const n of quarantined()) rmSync(join(stateDir, n)); };
  const corrupt = (text: string) => {
    const f = join(stateDir, "prompt-queue.json");
    writeFileSync(f, text);
    utimesSync(f, new Date(), new Date(Date.now() + 5_000));
  };

  it("recovers empty on a corrupt file and sets the file aside", () => {
    corrupt("{not json");
    expect(pq.readAllQueues()).toEqual({});
    expect(quarantined()).toHaveLength(1);
    expect(readFileSync(join(stateDir, quarantined()[0]), "utf8")).toBe("{not json");
    clearQuarantine();
  });

  it("keeps other sessions' attachment blobs while a corrupt queue file is set aside", () => {
    const big = "A".repeat(600 * 1024); // above BLOB_OFFLOAD_CHARS → stored out-of-line
    pq.writeSessionQueue("s-keep", [{ id: "q-k", blocks: [{ type: "image", data: big, mimeType: "image/png" }] }]);
    const blob = readdirSync(join(stateDir, "queue-blobs")).find((n) => n.startsWith("s-keep--"))!;
    expect(blob).toBeTruthy();
    corrupt("{truncated");
    pq.writeSessionQueue("s-new", [{ id: "q-n", blocks: blk("after corruption") }]);
    expect(quarantined()).toHaveLength(1);
    expect(existsSync(join(stateDir, "queue-blobs", blob))).toBe(true);
    expect(pq.readAllQueues()["s-new"]?.[0]?.blocks).toEqual(blk("after corruption"));
    clearQuarantine();
    pq.writeSessionQueue("s-new", []);
    expect(existsSync(join(stateDir, "queue-blobs", blob))).toBe(false); // resolved → normal sweep resumes
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

  it("an unreadable queue file is left untouched and persistence pauses until it is readable again", async () => {
    if (process.getuid?.() === 0) return; // chmod 000 is a no-op for root
    const f = qfile();
    const img = { type: "image" as const, data: bigData, mimeType: "image/png" };
    pq.writeSessionQueue("s-old", [{ id: "q-old", blocks: blk("keep me") }]);
    pq.writeSessionQueue("s-img2", [{ id: "q-img2", blocks: [img] }]);
    const blob = readdirSync(join(stateDir, "queue-blobs")).find((n) => n.startsWith("s-img2--"))!;
    const bytes = readFileSync(f);
    try {
      chmodSync(f, 0o000);
      vi.resetModules();
      const cold = await import("../lib/promptQueue");
      // cold start: unreadable file reads as empty, no quarantine, no write
      expect(cold.readAllQueues()).toEqual({});
      expect(quarantined()).toHaveLength(0);
      cold.writeSessionQueue("s-new", [{ id: "q-n", blocks: blk("lost?") }]);
      expect(existsSync(join(stateDir, "queue-blobs", blob))).toBe(true);
      chmodSync(f, 0o600);
      expect(readFileSync(f)).toEqual(bytes); // the unreadable file was never renamed over
      // readable again → the next mutation merges with the existing sessions
      cold.writeSessionQueue("s-new2", [{ id: "q-n2", blocks: blk("now") }]);
      const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, { id: string }[]>;
      expect(Object.keys(raw)).toEqual(expect.arrayContaining(["s-old", "s-img2", "s-new2"]));
      expect(existsSync(join(stateDir, "queue-blobs", blob))).toBe(true);
      const all = cold.readAllQueues();
      expect(all["s-old"]?.[0]?.blocks).toEqual(blk("keep me"));
      expect(all["s-img2"]?.[0]?.blocks).toEqual([img]);
    } finally {
      if (existsSync(f)) chmodSync(f, 0o600);
    }
  });

  it("a transiently unreadable blob fails the whole load without dropping the entry or sweeping", async () => {
    writeFileSync(qfile(), JSON.stringify({
      "s-dir": [{ id: "q-dir", blocks: [{ type: "image", mimeType: "image/png", dataBlob: "blobdir" }] }],
    }));
    const blobPath = join(stateDir, "queue-blobs", "blobdir");
    mkdirSync(blobPath, { recursive: true }); // EISDIR — works for any uid
    try {
      vi.resetModules();
      const cold = await import("../lib/promptQueue");
      const bytes = readFileSync(qfile());
      expect(cold.readAllQueues()).toEqual({});
      expect(quarantined()).toHaveLength(0);
      cold.writeSessionQueue("s-x", [{ id: "q-x", blocks: blk("nope") }]);
      expect(readFileSync(qfile())).toEqual(bytes); // file not rewritten
      expect(existsSync(blobPath)).toBe(true);
      // restore the blob → the entry hydrates again and survives the save
      rmSync(blobPath, { recursive: true, force: true });
      writeFileSync(blobPath, "blobdata");
      cold.writeSessionQueue("s-y", [{ id: "q-y", blocks: blk("now") }]);
      const all = cold.readAllQueues();
      expect(all["s-dir"]?.[0]?.blocks).toEqual([{ type: "image", mimeType: "image/png", data: "blobdata" }]);
      const raw = JSON.parse(readFileSync(qfile(), "utf8")) as Record<string, { id: string }[]>;
      expect(raw["s-dir"]?.[0]?.id).toBe("q-dir");
      expect(raw["s-y"]?.[0]?.id).toBe("q-y");
    } finally {
      rmSync(blobPath, { recursive: true, force: true });
    }
  });

  it("logs the read failure once per streak, not per call", async () => {
    rmSync(qfile(), { force: true });
    mkdirSync(qfile()); // a directory at the file path: EISDIR for any uid
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const cold = await import("../lib/promptQueue");
      cold.readAllQueues();
      cold.readAllQueues();
      cold.writeSessionQueue("s-z", [{ id: "q-z", blocks: blk("x") }]);
      const logs = spy.mock.calls.filter((c) => String(c[0]).includes("cannot read prompt-queue.json"));
      expect(logs).toHaveLength(1);
    } finally {
      spy.mockRestore();
      rmSync(qfile(), { recursive: true, force: true });
    }
  });
});
