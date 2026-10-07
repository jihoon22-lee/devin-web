// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Code, Sparkles } from "lucide-react";
import type { SessionConfigOption } from "../lib/acp/types";
import {
  classifyConfig,
  loadRecentModels,
  modeIcon,
  modelEffortTag,
  modelGroup,
  optionSupportsImages,
  pushRecentModel,
  shortModelName,
} from "../lib/client/configOptions";

const opt = (over: Partial<SessionConfigOption>): SessionConfigOption => ({
  id: "x",
  name: "X",
  type: "select",
  ...over,
});

describe("classifyConfig", () => {
  it("classifies by id", () => {
    const c = classifyConfig([
      opt({ id: "model", name: "Model" }),
      opt({ id: "mode", name: "Mode" }),
      opt({ id: "thought_level", name: "Thinking" }),
    ]);
    expect(c.mode?.id).toBe("mode");
    expect(c.model?.id).toBe("model");
    expect(c.thought?.id).toBe("thought_level");
    expect(c.extra).toEqual([]);
  });

  it("classifies by category when the id differs", () => {
    const c = classifyConfig([
      opt({ id: "session-mode", category: "mode" }),
      opt({ id: "engine", category: "model" }),
      opt({ id: "reasoning", category: "thought_level" }),
    ]);
    expect(c.mode?.id).toBe("session-mode");
    expect(c.model?.id).toBe("engine");
    expect(c.thought?.id).toBe("reasoning");
  });

  it("sends model_config selects, booleans and unknowns to extra", () => {
    const speed = opt({ id: "speed", name: "Speed", category: "model_config" });
    const flag = opt({ id: "verbose", name: "Verbose", type: "boolean", currentValue: false });
    const misc = opt({ id: "region", name: "Region" });
    const c = classifyConfig([speed, flag, misc]);
    expect(c.extra.map((o) => o.id)).toEqual(["speed", "verbose", "region"]);
    expect(c.mode).toBeUndefined();
    expect(c.model).toBeUndefined();
    expect(c.thought).toBeUndefined();
  });

  it("handles missing/empty input", () => {
    expect(classifyConfig(undefined)).toEqual({ extra: [] });
    expect(classifyConfig(null)).toEqual({ extra: [] });
    expect(classifyConfig([])).toEqual({ extra: [] });
  });
});

describe("modelGroup", () => {
  it.each([
    ["fusion-alpha", "Fusion"],
    ["claude-opus-4.6", "Claude"],
    ["gpt-5.2-codex", "GPT"],
    ["gemini-3-pro", "Gemini"],
    ["swe-1.6", "SWE"],
    ["grok-4", "Grok"],
    ["glm-5", "GLM"],
    ["deepseek-v3", "DeepSeek"],
    ["kimi-k2", "Kimi"],
    ["adaptive", "Other"],
    ["mystery", "Other"],
  ])("%s → %s", (v, g) => {
    expect(modelGroup(v)).toBe(g);
  });
});

describe("optionSupportsImages", () => {
  const model = opt({
    id: "model",
    options: [
      { value: "a", name: "A", _meta: { "cognition.ai/supportsImages": true } },
      { value: "b", name: "B", _meta: { "cognition.ai/supportsImages": false } },
      { value: "c", name: "C", _meta: { "cognition.ai/supportsImages": "yes" } },
      { value: "d", name: "D", _meta: null },
      { value: "e", name: "E" },
    ],
  });
  it("reads the boolean meta flag", () => {
    expect(optionSupportsImages(model, "a")).toBe(true);
    expect(optionSupportsImages(model, "b")).toBe(false);
  });
  it("reports undefined for non-boolean/missing meta and unknown values", () => {
    expect(optionSupportsImages(model, "c")).toBeUndefined();
    expect(optionSupportsImages(model, "d")).toBeUndefined();
    expect(optionSupportsImages(model, "e")).toBeUndefined();
    expect(optionSupportsImages(model, "zzz")).toBeUndefined();
    expect(optionSupportsImages(opt({ id: "model" }), "a")).toBeUndefined();
  });
});

describe("modeIcon / shortModelName", () => {
  it("maps known icon names and ignores the rest", () => {
    expect(modeIcon({ _meta: { "cognition.ai/icon": "code" } })).toBe(Code);
    expect(modeIcon({ _meta: { "cognition.ai/icon": "sparkles" } })).toBe(Sparkles);
    expect(modeIcon({ _meta: { "cognition.ai/icon": "nope" } })).toBeUndefined();
    expect(modeIcon({ _meta: { "cognition.ai/icon": 3 } })).toBeUndefined();
    expect(modeIcon({ _meta: null })).toBeUndefined();
    expect(modeIcon(undefined)).toBeUndefined();
  });

  it("shortModelName resolves the option name, else the raw value", () => {
    const model = opt({ id: "model", options: [{ value: "v1", name: "Very Long Name" }] });
    expect(shortModelName(model, "v1")).toBe("Very Long Name");
    expect(shortModelName(model, "v2")).toBe("v2");
    expect(shortModelName(undefined, "v")).toBe("v");
  });
});

describe("modelEffortTag", () => {
  it.each([
    ["swe-2-high", "SWE-2", "high"],
    ["claude-sonnet-5-medium", "Claude Sonnet 5", "medium"],
    ["glm-5-3-flash-max", "GLM-5.3 Flash", "max"],
    ["swe-1-7-lightning-medium", "SWE-1.7 Lightning", "medium"],
    ["gpt-6-astra-medium", undefined, "medium"],
  ])("%s → %s", (v, name, tag) => {
    expect(modelEffortTag(v, name)).toBe(tag);
  });

  it("skips names that already mention the tier and untagged values", () => {
    expect(modelEffortTag("glm-5-2", "GLM-5.2 High")).toBeUndefined();
    expect(
      modelEffortTag(
        "fusion-gpt-6-astra-high-sidekick-swe-2-high",
        "Fusion (GPT-6 Astra High Thinking + SWE-2 High)",
      ),
    ).toBeUndefined();
    expect(modelEffortTag("adaptive", "Adaptive")).toBeUndefined();
    expect(modelEffortTag("claude-opus-4-7-medium", undefined)).toBe("medium");
  });
});

describe("recent models (MRU)", () => {
  beforeEach(() => localStorage.clear());

  it("prepends, dedupes and caps at 5", () => {
    pushRecentModel("a");
    pushRecentModel("b");
    pushRecentModel("c");
    expect(loadRecentModels()).toEqual(["c", "b", "a"]);
    pushRecentModel("a"); // re-push moves to front
    expect(loadRecentModels()).toEqual(["a", "c", "b"]);
    for (const v of ["d", "e", "f", "g"]) pushRecentModel(v);
    expect(loadRecentModels()).toEqual(["g", "f", "e", "d", "a"]);
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem("dw-recent-models", "{not json");
    expect(loadRecentModels()).toEqual([]);
    localStorage.setItem("dw-recent-models", JSON.stringify(["ok", 1, null]));
    expect(loadRecentModels()).toEqual(["ok"]);
  });
});
