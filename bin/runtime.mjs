// Shared startup checks. Keep this module free of writes and process creation:
// ctl runs it before stopping a working web or arming its supervisor.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 24 || minor < 18 || version.includes("-")) {
    throw new Error(`Node.js >=24.18.0 <25 is required (found ${version}). Install a supported Node.js 24 release.`);
  }
}

/** @param {string[]} args @param {Record<string, string | undefined>} env */
export function launchOptions(args = [], env = process.env) {
  let rawPort = env.DEVIN_WEB_PORT ?? env.PORT ?? "7100";
  let host = "127.0.0.1";
  let dev = false;
  let noOpen = !!env.DEVIN_WEB_NO_OPEN;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dev") dev = true;
    else if (arg === "--no-open") noOpen = true;
    else if (arg === "--port" || arg === "-p" || arg === "--host" || arg === "-H") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--port" || arg === "-p") rawPort = value;
      else host = value;
    } else if (arg.startsWith("--port=")) rawPort = arg.slice(7);
    else if (arg.startsWith("--host=")) host = arg.slice(7);
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
  }
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error(`Invalid port ${JSON.stringify(rawPort)}: expected an integer from 1 to 65535.`);
  }
  if (!host || /\s/.test(host)) throw new Error("--host requires a nonempty hostname or IP address");
  const distDir = env.DEVIN_WEB_DIST_DIR ?? ".next";
  if (!distDir.trim()) throw new Error("DEVIN_WEB_DIST_DIR must not be empty");
  return { port: Number(rawPort), host, dev, noOpen, distDir };
}

export function preflight(root, options) {
  validateNode();
  const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
  const require = createRequire(join(root, "package.json"));
  try {
    if (!existsSync(nextBin)) throw new Error("next");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.dependencies ?? {})) require.resolve(name);
    // Resolving the package alone does not verify its compiled PTY binding.
    if (pkg.dependencies?.["node-pty"]) require("node-pty");
  } catch {
    throw new Error("Required dependencies are missing. Run `pnpm install --frozen-lockfile` before starting devin-web.");
  }
  if (!options.dev) {
    const buildId = resolve(root, options.distDir, "BUILD_ID");
    let built = false;
    try { built = statSync(buildId).isFile() && !!readFileSync(buildId, "utf8").trim(); } catch {}
    if (!built) throw new Error(`Production build missing at ${buildId}. Run \`pnpm build\` with the same DEVIN_WEB_DIST_DIR, or use explicit --dev for development.`);
  }
  return nextBin;
}

export async function checkPort(port, host) {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(`Cannot listen on ${host}:${port}: ${error.message}`)));
    server.listen({ port, host, exclusive: true }, () => server.close(resolvePort));
  });
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const options = launchOptions();
    preflight(root, options);
    if (process.argv.includes("--check-port")) await checkPort(options.port, options.host);
  } catch (error) {
    console.error(`devin-web: ${error.message}`);
    process.exitCode = 1;
  }
}
