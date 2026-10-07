import { describe, expect, it } from "vitest";
import { rankMatches } from "../app/api/fs/complete/route";

describe("fs/complete rank", () => {
  const files = [
    { path: "src/app.ts", name: "app.ts", isDir: false },
    { path: "src/utils/application.ts", name: "application.ts", isDir: false },
    { path: "docs/api.md", name: "api.md", isDir: false },
    { path: "appdir", name: "appdir", isDir: true },
  ];

  it("prefix matches beat substring matches", () => {
    const out = rankMatches(files, "app");
    expect(out[0].path).toBe("appdir"); // shortest prefix match
    expect(out[1].path).toBe("src/app.ts");
    expect(out[2].path).toBe("src/utils/application.ts");
    expect(out.find((f) => f.path === "docs/api.md")).toBeUndefined();
  });

  it("empty query returns sorted files", () => {
    const out = rankMatches(files, "");
    expect(out.length).toBe(4);
  });
});
