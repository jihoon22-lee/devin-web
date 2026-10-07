import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Inline `onKeyDown={...}` handler bodies (brace-matched). */
function onKeyDownBlocks(src: string): string[] {
  const out: string[] = [];
  let at = 0;
  while ((at = src.indexOf("onKeyDown={", at)) >= 0) {
    const begin = at + "onKeyDown=".length; // the "{"
    let depth = 0;
    let i = begin;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(begin, i + 1));
    at = i;
  }
  return out;
}

describe("IME hygiene (M4)", () => {
  it("every inline onKeyDown that handles Enter checks isImeComposing first", () => {
    const dir = join(process.cwd(), "components");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      for (const block of onKeyDownBlocks(readFileSync(join(dir, f), "utf8"))) {
        if (/key === "Enter"/.test(block) && !block.includes("isImeComposing(")) {
          offenders.push(`${f}: ${block.slice(0, 90).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
