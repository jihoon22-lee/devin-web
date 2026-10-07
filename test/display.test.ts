import { describe, expect, it } from "vitest";
import { displayTitle, tildePath } from "../lib/client/display";

describe("tildePath", () => {
  it("abbreviates home directories only at the start", () => {
    expect(tildePath("/home/example/projects/x")).toBe("~/projects/x");
    expect(tildePath("/Users/kim/code")).toBe("~/code");
    expect(tildePath("/root")).toBe("~");
    expect(tildePath("/rootfs/x")).toBe("/rootfs/x");
    expect(tildePath("/srv/home/a")).toBe("/srv/home/a");
  });
});

describe("displayTitle", () => {
  it("falls back for empty titles", () => {
    expect(displayTitle(null, "sid-1")).toBe("sid-1");
    expect(displayTitle("   ", "sid-1")).toBe("sid-1");
  });

  it("strips inline markdown", () => {
    expect(displayTitle("보고서 검토 완료. **전반적 평가**: 결함 3건", "x")).toBe("보고서 검토 완료. 전반적 평가: 결함 3건");
    expect(displayTitle("## Fix `useFoo` in [docs](http://a)", "x")).toBe("Fix useFoo in docs");
  });

  it("turns a leaked tool call into its description", () => {
    expect(displayTitle('functions.shell:0{"command": "ls -la", "description": "List current dir"}', "x")).toBe("⚙ List current dir");
    expect(displayTitle('functions.exec:2{"command": "pnpm test"}', "x")).toBe("⚙ pnpm test");
    expect(displayTitle("functions.shell:0{}", "x")).toBe("Untitled session");
  });

  it("leaves ordinary titles alone", () => {
    expect(displayTitle("외부 라이브러리 도입과 SWE-2 서브에이전트 활용", "x")).toBe("외부 라이브러리 도입과 SWE-2 서브에이전트 활용");
  });
});
