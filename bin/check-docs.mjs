#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const root = process.cwd();
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter((p) => p.endsWith(".md"));
const anchors = (body) => {
  const seen = new Map();
  return new Set(body.replace(/```[\s\S]*?```/g, "").split("\n").filter((s) => /^#{1,6} /.test(s)).map((s) => {
    const base = s.replace(/^#+\s+/, "").toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0; seen.set(base, n + 1); return n ? `${base}-${n}` : base;
  }));
};
let failed = false;
for (const file of files) {
  const body = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
    const [pathname, fragment] = link.split("#");
    const target = resolve(dirname(resolve(root, file)), decodeURIComponent(pathname || relative(dirname(file), file)));
    if (!target.startsWith(`${root}/`) || !existsSync(target)) { console.error(`${file}: missing local link ${link}`); failed = true; continue; }
    if (fragment && target.endsWith(".md") && !anchors(readFileSync(target, "utf8")).has(decodeURIComponent(fragment))) {
      console.error(`${file}: missing heading ${link}`); failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`Checked local links and headings in ${files.length} Markdown files.`);
