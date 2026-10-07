/** Prompt attachment caps — one source of truth for the prompt route, the
 *  composer and the proxy body limit in next.config.ts (test/limits.test.ts
 *  pins next.config ≥ PROMPT_MAX_BODY_BYTES). Client-safe: constants only. */
export const PROMPT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROMPT_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
/** base64 inflates 4/3; JSON framing + the prompt text ride on top (8MB). */
export const PROMPT_MAX_BODY_BYTES = Math.ceil((PROMPT_MAX_TOTAL_BYTES * 4) / 3) + 8 * 1024 * 1024;
/** Per-session parked-queue byte cap — queued blocks carry base64 payloads
 *  inline, so the 50-entry count cap alone could pin ~2GB per session in
 *  memory (and bloat prompt-queue.json). Roughly two maximum-size prompts'
 *  worth of serialized blocks. */
export const QUEUE_MAX_BYTES = 2 * PROMPT_MAX_BODY_BYTES;
