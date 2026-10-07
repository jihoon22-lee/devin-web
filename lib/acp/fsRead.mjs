// Agent `fs/read_text_file` — ONE implementation shared by the in-process
// bridge (lib/acp/bridge.ts) and devin-acpd (lib/acp/daemon.mjs), which used
// to carry drifting copies. Changes here need `ctl acpd restart --when-idle`.
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";

/** Bytes a single read may return. Whole-file reads keep the first MAX
 *  bytes; ranged reads cap the RETURNED slice, so every line stays reachable. */
export const MAX_FILE_READ = 1024 * 1024;

/** Largest cut <= cap that doesn't split a UTF-8 sequence. */
function utf8Floor(buf, cap) {
  let end = Math.min(cap, buf.length);
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}

async function readWhole(path, cap) {
  const st = await stat(path);
  if (st.size <= cap) return readFile(path, "utf8");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(cap + 4); // +4: see the byte after the cut
    const { bytesRead } = await fh.read(buf, 0, cap + 4, 0);
    const end = utf8Floor(buf.subarray(0, bytesRead), cap);
    return buf.toString("utf8", 0, end) + `\n…[truncated: ${st.size} bytes total, showing first ${end}]`;
  } finally {
    await fh.close();
  }
}

/** Lines [line, line+limit) — 1-based `line`, same result as the old
 *  `content.split("\n").slice(start, end).join("\n")` ("\r" stays on its
 *  line, a trailing "\n" yields a final empty line) — but streamed, so a
 *  range past the first MB is reachable. `cap` bounds the returned text. */
function readLineRange(path, line, limit, cap) {
  const start = Math.max(0, (line ?? 1) - 1);
  const max = limit != null ? Math.max(0, limit) : Infinity;
  return new Promise((resolve, reject) => {
    const out = [];
    let bytes = 0;
    let idx = 0; // index of the line being assembled
    let partial = "";
    let finished = false;
    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
    const done = (note = "") => {
      if (finished) return;
      finished = true;
      stream.destroy();
      resolve(out.join("\n") + note);
    };
    // false once the range or the byte budget is exhausted
    const take = (text) => {
      if (out.length >= max) return false;
      bytes += Buffer.byteLength(text) + 1;
      if (bytes > cap) {
        done(`\n…[truncated: range exceeds ${cap} bytes]`);
        return false;
      }
      out.push(text);
      return out.length < max;
    };
    stream.on("data", (chunk) => {
      if (finished) return;
      let off = 0;
      let nl;
      while ((nl = chunk.indexOf("\n", off)) >= 0) {
        const text = idx >= start ? partial + chunk.slice(off, nl) : "";
        partial = "";
        off = nl + 1;
        if (idx >= start && !take(text)) return done();
        idx++;
      }
      if (idx >= start) {
        partial += chunk.slice(off);
        if (partial.length > cap) {
          // one enormous line (a minified bundle) — bound it
          out.push(partial.slice(0, cap));
          return done(`\n…[truncated: line ${idx + 1} exceeds ${cap} chars]`);
        }
      }
    });
    stream.on("end", () => {
      // the text after the last "\n" is a line too (possibly empty)
      if (!finished && idx >= start && out.length < max) take(partial);
      done();
    });
    stream.on("error", (e) => {
      if (finished) return;
      finished = true;
      reject(e);
    });
  });
}

export function readTextFile(path, line, limit) {
  return line != null || limit != null
    ? readLineRange(path, line, limit, MAX_FILE_READ)
    : readWhole(path, MAX_FILE_READ);
}
