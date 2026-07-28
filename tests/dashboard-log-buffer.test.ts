import { describe, expect, test } from "bun:test";
import {
  appendLogEntries,
  createLogBuffer,
  getVirtualLogRange,
} from "../src/dashboard-app";

function log(id: number, msg: string) {
  return {
    id,
    level: "out" as const,
    msg,
    name: "test",
    ts: "now",
  };
}

describe("dashboard browser log buffer", () => {
  test("retains the newest entries within a byte budget", () => {
    const result = appendLogEntries(
      createLogBuffer(),
      [log(1, "a".repeat(80)), log(2, "b".repeat(80))],
      {
        maxBytes: 180,
        maxEntries: 10,
        maxLines: 10,
      }
    );

    expect(result.logs.map(({ id }) => id)).toEqual([2]);
    expect(result.retainedBytes).toBeLessThanOrEqual(180);
    expect(result.localDropped).toBe(1);
  });

  test("tracks server drops and local line-limit evictions separately", () => {
    const result = appendLogEntries(
      createLogBuffer(),
      [log(1, "one\ntwo\nthree")],
      {
        maxBytes: 1_000,
        maxEntries: 10,
        maxLines: 2,
        serverDropped: 7,
      }
    );

    expect(result.logs).toEqual([]);
    expect(result.serverDropped).toBe(7);
    expect(result.localDropped).toBe(1);
  });

  test("replacing with a fresh snapshot resets previous loss counts", () => {
    const previous = appendLogEntries(
      createLogBuffer(),
      [log(1, "old"), log(2, "old")],
      {
        maxBytes: 100,
        maxEntries: 10,
        maxLines: 10,
        serverDropped: 4,
      }
    );
    const snapshot = appendLogEntries(previous, [log(3, "snapshot")], {
      replace: true,
    });

    expect(snapshot.logs.map(({ id }) => id)).toEqual([3]);
    expect(snapshot.serverDropped).toBe(0);
    expect(snapshot.localDropped).toBe(0);
  });

  test("virtualizes to the viewport plus a small overscan window", () => {
    const middle = getVirtualLogRange(1_000, 9_000, 360);
    const bottom = getVirtualLogRange(1_000, 18_000 - 360, 360);

    expect(middle.start).toBeGreaterThan(0);
    expect(middle.end).toBeLessThan(1_000);
    expect(middle.end - middle.start).toBeLessThanOrEqual(44);
    expect(middle.offset).toBe(middle.start * 18);
    expect(bottom.end).toBe(1_000);
  });
});
