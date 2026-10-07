import { CSRF_HEADER } from "@/lib/security/requestGuard";
import type { ContentBlock } from "@/lib/acp/types";

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
  return body as T;
}

export const sendPrompt = (
  sessionId: string,
  text: string,
  images?: { data: string; mimeType: string }[],
  mentions?: { path: string; name?: string }[],
) =>
  api(`/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, images, mentions }),
  });

export const cancelPrompt = (sessionId: string, clearQueue = false) =>
  api(`/api/sessions/${sessionId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ clearQueue }),
  });

export const respondRequest = (sessionId: string, requestId: string, result: unknown) =>
  api(`/api/sessions/${sessionId}/respond`, {
    method: "POST",
    body: JSON.stringify({ requestId, result }),
  });

export const cancelRequest = (sessionId: string, requestId: string) =>
  api(`/api/sessions/${sessionId}/respond`, {
    method: "POST",
    body: JSON.stringify({ requestId, cancel: true }),
  });

export const setConfig = (sessionId: string, configId: string, value: string | boolean) =>
  api(`/api/sessions/${sessionId}/config`, {
    method: "POST",
    body: JSON.stringify({ configId, value }),
  });

export const forkSession = (sessionId: string, cwd: string, nodeId?: number) =>
  api<{ sessionId: string }>(`/api/sessions/${sessionId}/fork`, {
    method: "POST",
    body: JSON.stringify({ cwd, ...(nodeId != null ? { nodeId } : {}) }),
  });

export const dequeuePrompt = (sessionId: string, id: string) =>
  api<{ blocks: ContentBlock[] }>(`/api/sessions/${sessionId}/dequeue`, {
    method: "POST",
    body: JSON.stringify({ id }),
  });

export const dismissNotice = (sessionId: string, id: string) =>
  api(`/api/sessions/${sessionId}/dismiss-notice`, {
    method: "POST",
    body: JSON.stringify({ id }),
  });

/** send-now — steer a parked prompt into the live turn instead of waiting
 *  for the queue to drain */
export const sendQueuedPrompt = (sessionId: string, id: string) =>
  api<{ sent: boolean }>(`/api/sessions/${sessionId}/dequeue`, {
    method: "POST",
    body: JSON.stringify({ id, send: true }),
  });

export const renameSession = (sessionId: string, title: string) =>
  api<{ ok: boolean; queued: boolean }>(`/api/sessions/${sessionId}/rename`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });

export const shareSession = (sessionId: string) =>
  api<Record<string, unknown>>(`/api/sessions/${sessionId}/share`, { method: "POST", body: "{}" });
