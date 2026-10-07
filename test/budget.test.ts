import { describe, expect, it } from "vitest";
import { budgetState, localDay } from "../lib/client/budget";

describe("budgetState", () => {
  it("is off without a budget", () => {
    expect(budgetState([{ day: "2026-10-04", outputTokens: 9 }], null, "2026-10-04")).toBeNull();
  });
  it("reads only today's bucket", () => {
    const daily = [{ day: "2026-10-03", outputTokens: 900 }, { day: "2026-10-04", outputTokens: 120 }];
    expect(budgetState(daily, 100, "2026-10-04")).toEqual({ used: 120, budget: 100, over: true, ratio: 1 });
    expect(budgetState(daily, 1000, "2026-10-05")).toMatchObject({ used: 0, over: false, ratio: 0 });
  });
  it("formats the local day", () => {
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
