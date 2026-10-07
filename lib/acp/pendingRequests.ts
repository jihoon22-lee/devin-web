import { randomBytes } from "node:crypto";
import type { ClientRequestEvent } from "./bridge";
import { METHODS } from "./types";

/** Human-readable resolution for the resolved card — every viewer sees the
 *  same label because it rides the client_request_done event. */
function describeOutcome(params: Record<string, unknown>, result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const oc = r.outcome;
  if (oc && typeof oc === "object") {
    const o = oc as Record<string, unknown>;
    if (o.outcome === "cancelled") return "Cancelled";
    if (o.outcome === "selected" && typeof o.optionId === "string") {
      const opts = Array.isArray(params.options) ? params.options : [];
      const hit = opts.find(
        (x) => x && typeof x === "object" && (x as { optionId?: unknown }).optionId === o.optionId,
      ) as { name?: unknown } | undefined;
      return typeof hit?.name === "string" ? hit.name : o.optionId;
    }
    return undefined;
  }
  // elicitation replies carry { action: "accept" | "decline" | "cancel" }
  const action = r.action;
  if (action === "accept") return "Accepted";
  if (action === "decline") return "Declined";
  if (action === "cancel") return "Cancelled";
  return undefined;
}

export interface PendingClientRequest {
  requestId: string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: number;
  respond: (result: unknown) => void;
  respondError: (code: number, message: string) => void;
}

/** Agent→client requests (permission / elicitation) waiting for a browser
 *  answer. Ids are `req-<seq>-<random>` — a bare `req-N` is enumerable and a
 *  same-host process could answer another session's card by guessing — and
 *  every answer is bound to the session that owns the request. Daemon-backed
 *  requests carry an opaque stable id so replay updates the persisted card. */
export class PendingRequests {
  readonly map = new Map<string, PendingClientRequest>();
  private seq = 0;

  constructor(
    private hooks: {
      emit: (sessionId: string, type: string, data: unknown) => void;
      /** the sidebar's needs-input badge reads forSession() — nudge a refetch */
      changed: () => void;
    },
  ) {}

  add(ev: ClientRequestEvent): PendingClientRequest {
    const sessionId = (ev.params.sessionId as string) ?? "";
    const requestId = ev.requestId ?? `req-${++this.seq}-${randomBytes(6).toString("hex")}`;
    const settle = (resolvedWith?: string) => {
      this.hooks.emit(sessionId, "client_request_done", { requestId, resolvedWith });
      this.hooks.changed();
    };
    const pr: PendingClientRequest = {
      requestId,
      sessionId,
      method: ev.method,
      params: ev.params,
      createdAt: Date.now(),
      respond: (result) => {
        this.map.delete(requestId);
        ev.respond(result);
        settle(describeOutcome(ev.params, result));
      },
      respondError: (code, message) => {
        this.map.delete(requestId);
        ev.respondError(code, message);
        settle();
      },
    };
    this.map.set(requestId, pr);
    this.hooks.emit(sessionId, "client_request", { requestId, method: ev.method, params: ev.params });
    this.hooks.changed();
    return pr;
  }

  forSession(sessionId?: string): PendingClientRequest[] {
    return [...this.map.values()].filter((r) => !sessionId || r.sessionId === sessionId);
  }

  /** `sessionId` = the session route the answer arrived under (must own it). */
  respond(requestId: string, result: unknown, sessionId?: string): boolean {
    const pr = this.map.get(requestId);
    if (!pr || (sessionId && pr.sessionId !== sessionId)) return false;
    pr.respond(result);
    return true;
  }

  cancel(requestId: string, sessionId?: string): boolean {
    const pr = this.map.get(requestId);
    if (!pr || (sessionId && pr.sessionId !== sessionId)) return false;
    if (pr.method === METHODS.requestPermission) pr.respond({ outcome: { outcome: "cancelled" } });
    else if (pr.method === METHODS.elicitationCreate) pr.respond({ action: "cancel" });
    else pr.respondError(-32603, "cancelled by user");
    return true;
  }

  rejectAll(code: number, message: string) {
    for (const pr of [...this.map.values()]) pr.respondError(code, message);
  }
}
