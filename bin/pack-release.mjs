#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Usage: node bin/pack-release.mjs <full commit SHA>");
if (execFileSync("git", ["cat-file", "-t", sha], { encoding: "utf8" }).trim() !== "commit") throw new Error("Source SHA must identify a commit");
const pkg = JSON.parse(execFileSync("git", ["show", `${sha}:package.json`], { encoding: "utf8" }));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Expected a stable semantic version");
mkdirSync("release", { recursive: true });
const name = `devin-web-${pkg.version}.tar.gz`;
const bytes = gzipSync(execFileSync("git", ["archive", "--format=tar", `--prefix=devin-web-${pkg.version}/`, sha], { maxBuffer: 50 * 1024 * 1024 }));
writeFileSync(`release/${name}`, bytes);
const digest = createHash("sha256").update(bytes).digest("hex");
writeFileSync("release/manifest.json", JSON.stringify({ version: pkg.version, commit: sha, node: process.version, pnpm: pkg.packageManager, source: name, sha256: digest }, null, 2) + "\n");
const manifestDigest = createHash("sha256").update(readFileSync("release/manifest.json")).digest("hex");
writeFileSync("release/SHA256SUMS", `${digest}  ${name}\n${manifestDigest}  manifest.json\n`);
console.log(`Packaged v${pkg.version} at ${sha}`);
