import { describe, expect, it } from "vitest";
import { integrityCount } from "../lib/integrityBeacon";
import { POST } from "../app/api/diag/route";

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/diag", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

describe("diag route integrity counter", () => {
  it("counts integrity beacons separately from other breadcrumbs", async () => {
    const before = integrityCount().total;
    await post({ t: "pagehide" });
    expect(integrityCount().total).toBe(before);
    await post({ t: "integrity", s: "s1", dupes: [{ a: "bf-1", b: "ev-2", chars: 140 }] });
    const after = integrityCount();
    expect(after.total).toBe(before + 1);
    expect(after.lastSig).toContain("s1");
  });
});
