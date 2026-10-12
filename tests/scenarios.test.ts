import { describe, expect, test } from "vitest";
import { allInterleavings, Lab, play, replay } from "../src/engine/lab";
import { scenarios, setupFor } from "../src/scenarios";

describe.each(scenarios)("$title", (scenario) => {
  test("the broken version fails in the order shown on screen", () => {
    const lab = play(new Lab(setupFor(scenario, "broken")), scenario.dangerousOrder);
    expect(lab.finished).toBe(true);
    expect(lab.outcome()?.ok).toBe(false);
  });

  test("the fixed version holds in the same order", () => {
    const lab = play(new Lab(setupFor(scenario, "fixed")), scenario.dangerousOrder);
    expect(lab.finished).toBe(true);
    expect(lab.outcome()?.ok).toBe(true);
  });

  test("the fixed version holds in every possible interleaving, and never deadlocks", () => {
    const setup = setupFor(scenario, "fixed");
    const orders = allInterleavings(setup);
    expect(orders.length).toBeGreaterThan(1);
    for (const order of orders) {
      const lab = replay(setup, order);
      expect(lab.stuck, `stuck after ${order}`).toBe(false);
      expect(lab.outcome()?.ok, `fails after ${order}`).toBe(true);
    }
  });

  test("the broken version is fine when the requests don't overlap", () => {
    const setup = setupFor(scenario, "broken");
    const first = setup.transactions[0].steps.length;
    const second = setup.transactions[1].steps.length;
    const lab = replay(setup, [...Array(first).fill(0), ...Array(second).fill(1)]);
    expect(lab.outcome()?.ok).toBe(true);
  });
});
