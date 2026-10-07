"use client";

import { useState } from "react";
import { CheckSquare, ExternalLink, MessageCircleQuestion, Square } from "lucide-react";
import type { ChatItem } from "@/lib/client/model";
import type { ElicitationRequest } from "@/lib/acp/types";
import { cancelRequest, respondRequest } from "@/lib/client/api";
import { useToast } from "./Toasts";

type ReqItem = Extract<ChatItem, { kind: "request" }>;

interface Choice {
  value: string;
  title: string;
  description?: string;
}

/** Normalize enum / oneOf / anyOf into labeled choices.
 *  enum: ["a","b"] · oneOf: [{const,title,description}] · mixed values. */
function choicesOf(p: Record<string, unknown>): Choice[] | null {
  const variants = (p.oneOf ?? p.anyOf) as
    | { const?: unknown; title?: string; description?: string }[]
    | undefined;
  if (Array.isArray(variants) && variants.length) {
    return variants.map((v) => ({
      value: String(v.const ?? v.title ?? ""),
      title: String(v.title ?? v.const ?? ""),
      description: v.description,
    }));
  }
  if (Array.isArray(p.enum) && p.enum.length) {
    return p.enum.map((v) => ({ value: String(v), title: String(v) }));
  }
  // multi-select: type:array with items.enum/oneOf (MultiSelectPropertySchema)
  const items = p.items as { enum?: unknown[]; oneOf?: { const?: unknown; title?: string; description?: string }[] } | undefined;
  if (p.type === "array" && items) {
    if (Array.isArray(items.oneOf) && items.oneOf.length) {
      return items.oneOf.map((v) => ({
        value: String(v.const ?? v.title ?? ""),
        title: String(v.title ?? v.const ?? ""),
        description: v.description,
      }));
    }
    if (Array.isArray(items.enum) && items.enum.length) {
      return items.enum.map((v) => ({ value: String(v), title: String(v) }));
    }
  }
  return null;
}

function isMulti(p: Record<string, unknown>): boolean {
  return p.type === "array";
}

/** elicitation/create — form or URL elicitation. */
export default function ElicitationCard({ item, sessionId }: { item: ReqItem; sessionId: string }) {
  const params = (item.params ?? {}) as unknown as ElicitationRequest;
  const schema = params.requestedSchema;
  // params arrive from the agent — malformed shapes must degrade, not crash
  const message = typeof params.message === "string" && params.message ? params.message : "The agent requests input.";
  const url = typeof params.url === "string" ? params.url : undefined;
  // seed from schema defaults (required booleans default to false so they
  // always carry a defined answer)
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(schema?.properties ?? {})) {
      const prop = p as Record<string, unknown>;
      if (prop.default !== undefined) init[k] = prop.default;
      else if (prop.type === "boolean") init[k] = false;
    }
    return init;
  });
  const [freeText, setFreeText] = useState("");
  // reveal the required-fields hint only after a submit attempt — showing it
  // on first render reads as an error before the user did anything
  const [submitted, setSubmitted] = useState(false);
  const toast = useToast();
  const fail = (e: unknown) => {
    const msg = (e as Error).message;
    toast(/no such pending request/.test(msg) ? "This request is no longer pending." : `Response failed: ${msg}`);
  };

  const respond = (action: string, content?: Record<string, unknown>) =>
    respondRequest(sessionId, item.requestId, { action, ...(content ? { content } : {}) }).catch(fail);

  if (params.mode === "url" && url) {
    return (
      <div className={`border rounded-xl px-3.5 py-3 ${item.resolved ? "border-(--color-border) opacity-50" : "border-(--color-accent)/60 bg-(--color-accent)/5"}`}>
        <div className="flex items-center gap-2 text-sm">
          <ExternalLink size={14} className="text-(--color-accent)" />
          <span className="font-medium">{message}</span>
        </div>
        {!item.resolved && (
          <div className="flex gap-2 mt-2">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1 rounded border border-(--color-accent)/60 text-xs text-(--color-accent)"
            >
              Open link
            </a>
            <button
              onClick={() => void respond("accept")}
              className="px-3 py-1 rounded bg-(--color-accent) text-black text-xs font-medium"
            >
              Done
            </button>
            <button
              onClick={() => void respond("cancel")}
              className="px-3 py-1 rounded border border-(--color-border) text-xs text-(--color-dim)"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  const props =
    schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const hasSchema = Object.keys(props).length > 0;

  const isNumeric = (p: Record<string, unknown>) => p.type === "number" || p.type === "integer";

  // required keys need a defined, non-empty answer (and a valid number for
  // numeric fields); `false` counts as answered for booleans.
  const missingRequired = [...required].some((k) => {
    const p = props[k] as Record<string, unknown> | undefined;
    const v = values[k];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return true;
    if (p && isNumeric(p) && typeof v === "string" && Number.isNaN(Number(v))) return true;
    return false;
  });

  // build the response content: coerce numeric fields, drop untouched
  // optional text fields entirely rather than sending ""
  const content = () => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === "") continue;
      const p = props[k] as Record<string, unknown> | undefined;
      out[k] = p && isNumeric(p) ? Number(v) : v;
    }
    return out;
  };

  return (
    <div className={`border rounded-xl px-3.5 py-3 ${item.resolved ? "border-(--color-border) opacity-50" : "border-(--color-accent)/60 bg-(--color-accent)/5"}`}>
      <div className="flex items-center gap-2 text-sm">
        <MessageCircleQuestion size={14} className="text-(--color-accent)" />
        <span className="font-medium whitespace-pre-wrap">{message}</span>
      </div>
      {!item.resolved && (
        <div className="mt-2 flex flex-col gap-2">
          {hasSchema ? (
            Object.entries(props).map(([key, p]) => {
              const choices = choicesOf(p as Record<string, unknown>);
              const multi = isMulti(p as Record<string, unknown>);
              const cur = values[key];
              const curArr = Array.isArray(cur) ? (cur as string[]) : [];
              return (
                <div key={key} className="flex flex-col gap-1 text-xs">
                  <span className="text-(--color-dim)">
                    {(p.title as string) || key}
                    {required.has(key) && <span className="text-(--color-red)"> *</span>}
                    {p.description && <span className="ml-1 opacity-70">— {String(p.description)}</span>}
                  </span>
                  {choices ? (
                    <div className="flex flex-col gap-1 mt-0.5">
                      {choices.map((c) => {
                        const on = multi ? curArr.includes(c.value) : cur === c.value;
                        return (
                          <button
                            key={c.value}
                            type="button"
                            onClick={() =>
                              setValues((v) => {
                                if (multi) {
                                  const a = Array.isArray(v[key]) ? (v[key] as string[]) : [];
                                  return {
                                    ...v,
                                    [key]: a.includes(c.value) ? a.filter((x) => x !== c.value) : [...a, c.value],
                                  };
                                }
                                return { ...v, [key]: c.value };
                              })
                            }
                            className={`flex items-start gap-2 text-left rounded-lg border px-2.5 py-1.5 transition-colors ${
                              on
                                ? "border-(--color-accent)/60 bg-(--color-accent)/10 text-white"
                                : "border-(--color-border) text-(--color-text) hover:border-(--color-border2) hover:bg-(--color-panel2)"
                            }`}
                          >
                            {multi ? (
                              on ? <CheckSquare size={13} className="mt-0.5 shrink-0 text-(--color-accent)" /> : <Square size={13} className="mt-0.5 shrink-0 text-(--color-faint)" />
                            ) : (
                              <span className={`mt-1 w-2 h-2 rounded-full shrink-0 border ${on ? "bg-(--color-accent) border-(--color-accent)" : "border-(--color-faint)"}`} />
                            )}
                            <span className="min-w-0">
                              <span className="block text-sm">{c.title}</span>
                              {c.description && (
                                <span className="block text-2xs text-(--color-dim) mt-0.5">{c.description}</span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : p.type === "boolean" ? (
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={!!cur}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.checked }))}
                    />
                  ) : (
                    <input
                      type={isNumeric(p as Record<string, unknown>) ? "number" : "text"}
                      className="bg-(--color-panel2) border border-(--color-border) rounded px-2 py-1.5 text-sm outline-none focus:border-(--color-accent)"
                      value={(cur as string | number) ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    />
                  )}
                </div>
              );
            })
          ) : (
            <input
              className="bg-(--color-panel2) border border-(--color-border) rounded px-2 py-1.5 text-sm outline-none focus:border-(--color-accent)"
              placeholder="Type a response…"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
            />
          )}
          <div className="flex gap-2 mt-1 items-center">
            <button
              aria-disabled={hasSchema && missingRequired}
              title={missingRequired ? "Required fields are missing" : undefined}
              onClick={() => {
                if (hasSchema && missingRequired) {
                  setSubmitted(true);
                  return;
                }
                void respond("accept", hasSchema ? content() : { response: freeText });
              }}
              className="px-3 py-1 rounded bg-(--color-accent) text-black text-xs font-medium aria-disabled:opacity-50"
            >
              Submit
            </button>
            {submitted && missingRequired && hasSchema && (
              <span className="text-2xs text-(--color-red)">required fields missing</span>
            )}
            <button
              onClick={() => void respond("decline")}
              className="px-3 py-1 rounded border border-(--color-border) text-xs text-(--color-dim)"
            >
              Decline
            </button>
            <button
              onClick={() => void cancelRequest(sessionId, item.requestId).catch(fail)}
              className="px-3 py-1 rounded border border-(--color-border) text-xs text-(--color-dim)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
