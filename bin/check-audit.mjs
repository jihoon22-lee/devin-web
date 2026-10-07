#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const exceptions = JSON.parse(readFileSync(new URL("../security/audit-exceptions.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const exception of exceptions) {
  const root = exception.pathPrefix.match(/^\. > ([^@]+)@/)?.[1];
  if (!root || !pkg.devDependencies?.[root] || pkg.dependencies?.[root] || pkg.optionalDependencies?.[root]) throw new Error("Audit exception must be rooted only in a development dependency");
}
const result = spawnSync("pnpm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
if (result.error) throw result.error;
let report;
try { report = JSON.parse(result.stdout); } catch { throw new Error("Dependency audit did not return valid JSON"); }
if (report.error || !report.metadata || !report.advisories || ![0, 1].includes(result.status)) throw new Error("Dependency audit failed to obtain advisory data");
let failures = 0;
for (const advisory of Object.values(report.advisories)) {
  if (!["high", "critical"].includes(advisory.severity)) continue;
  const allowed = exceptions.find((e) => advisory.url?.endsWith(e.advisory) && advisory.module_name === e.module && Date.now() < Date.parse(`${e.expires}T00:00:00Z`) && advisory.findings?.length && advisory.findings.every((f) => f.version === e.version && f.paths?.length && f.paths.every((p) => p.startsWith(e.pathPrefix))));
  if (allowed) console.log(`Reviewed development exception: ${allowed.advisory}, expires ${allowed.expires}`);
  else { console.error(`Unresolved ${advisory.severity}: ${advisory.module_name} ${advisory.url}`); failures++; }
}
if (failures) process.exit(1);
console.log("No unreviewed high/critical dependency advisories.");
