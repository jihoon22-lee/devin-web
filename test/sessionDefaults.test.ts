import { describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "../lib/acp/types";
import { applySessionDefaults } from "../lib/sessionDefaults";

const opt = (over: Partial<SessionConfigOption>): SessionConfigOption => ({
  id: "x",
  name: "X",
  type: "select",
  ...over,
});

const baseOpts: SessionConfigOption[] = [
  opt({
    id: "model",
    currentValue: "gpt-5",
    options: [
      { value: "gpt-5", name: "GPT-5" },
      { value: "claude-x", name: "Claude X" },
    ],
  }),
  opt({
    id: "thought_level",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  }),
  opt({
    id: "speed",
    category: "model_config",
    currentValue: "standard",
    options: [
      { value: "standard", name: "Standard" },
      { value: "fast", name: "Fast" },
    ],
  }),
];

describe("applySessionDefaults", () => {
  it("applies model first, then validates thought/speed against the response options", async () => {
    // after the model write the thought option set changes (per-model list)
    const postModel: SessionConfigOption[] = [
      opt({ id: "model", currentValue: "claude-x" }),
      opt({
        id: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "max", name: "Max" },
        ],
      }),
      opt({
        id: "speed",
        currentValue: "standard",
        options: [
          { value: "standard", name: "Standard" },
          { value: "fast", name: "Fast" },
        ],
      }),
    ];
    const calls: [string, string | boolean][] = [];
    const setter = vi.fn(async (cid: string, v: string | boolean) => {
      calls.push([cid, v]);
      return { configOptions: postModel };
    });
    await applySessionDefaults(
      setter,
      { model: "claude-x", thought_level: "high", speed: "fast" },
      baseOpts,
    );
    // "high" is not in the post-model thought list → skipped; speed applies
    expect(calls).toEqual([
      ["model", "claude-x"],
      ["speed", "fast"],
    ]);
  });

  it("skips values already current, not offered, or for absent options", async () => {
    const setter = vi.fn(async () => ({}));
    await applySessionDefaults(
      setter,
      {
        model: "gpt-5", // equals currentValue → no-op
        thought_level: "high",
        speed: "ludicrous", // not in options
      },
      baseOpts,
    );
    expect(setter.mock.calls).toEqual([["thought_level", "high"]]);
    await applySessionDefaults(setter, { thought_level: "medium" }, baseOpts);
    expect(setter).toHaveBeenCalledTimes(1);
  });

  it("swallows setter failures and keeps going", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const setter = vi.fn(async (cid: string) => {
      calls.push(cid);
      if (cid === "model") throw new Error("boom");
      return {};
    });
    await expect(
      applySessionDefaults(setter, { model: "claude-x", thought_level: "high" }, baseOpts),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["model", "thought_level"]);
    err.mockRestore();
  });

  it("tolerates missing current options and empty defaults", async () => {
    const setter = vi.fn(async () => ({}));
    await applySessionDefaults(setter, { model: "claude-x" });
    expect(setter).not.toHaveBeenCalled(); // unknown whether it's offered → skip
    await applySessionDefaults(setter, {}, baseOpts);
    expect(setter).not.toHaveBeenCalled();
  });
});
