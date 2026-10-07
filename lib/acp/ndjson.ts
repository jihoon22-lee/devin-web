/** Incremental NDJSON line decoder: feed arbitrary chunks, get complete lines. */
export class LineDecoder {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    // offset-scan, not per-line reslice — buf.slice(i+1) inside the loop
    // copies the whole tail per line (O(n²) on a big burst)
    let off = 0;
    let i: number;
    while ((i = this.buf.indexOf("\n", off)) >= 0) {
      let line = this.buf.slice(off, i);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      off = i + 1;
      if (line.trim()) lines.push(line);
    }
    this.buf = this.buf.slice(off);
    return lines;
  }

  /** Remaining incomplete data (empty unless stream ended mid-line). */
  get pending(): string {
    return this.buf;
  }
}

export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}
