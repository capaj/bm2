import { describe, expect, test } from "bun:test";
import {
  BatchProcessMonitor,
  type ProcessMonitoringTarget,
  type ProcessUsage,
} from "../src/process-monitor";
import { ProcessContainer } from "../src/process-container";

function target(
  pid: number,
  updates: Array<{ pid: number; usage: ProcessUsage; handles?: number }>
): ProcessMonitoringTarget {
  return {
    getMonitoringPid: () => pid,
    applyMonitoringStats: (sampledPid, usage, handles) => {
      updates.push({ pid: sampledPid, usage, handles });
    },
  };
}

describe("BatchProcessMonitor", () => {
  test("collects all process usage in one pidusage call", async () => {
    const updates: Array<{
      pid: number;
      usage: ProcessUsage;
      handles?: number;
    }> = [];
    const calls: number[][] = [];
    const monitor = new BatchProcessMonitor(
      () => [target(101, updates), target(202, updates)],
      {
        pidusage: async (pids) => {
          calls.push(pids);
          return {
            101: { cpu: 1, memory: 1000 },
            202: { cpu: 2, memory: 2000 },
          };
        },
        readHandles: async (pid) => pid / 101,
      }
    );

    await monitor.collectOnce();

    expect(calls).toEqual([[101, 202]]);
    expect(updates).toEqual([
      { pid: 101, usage: { cpu: 1, memory: 1000 }, handles: 1 },
      { pid: 202, usage: { cpu: 2, memory: 2000 }, handles: 2 },
    ]);
  });

  test("does not overlap an in-flight batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const monitor = new BatchProcessMonitor(
      () => [target(101, [])],
      {
        pidusage: async () => {
          calls++;
          await gate;
          return { 101: { cpu: 1, memory: 1000 } };
        },
        readHandles: async () => 0,
      }
    );

    const first = monitor.collectOnce();
    const overlapping = monitor.collectOnce();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, overlapping]);
    expect(calls).toBe(1);
  });

  test("samples handle counts less frequently than CPU and memory", async () => {
    let usageCalls = 0;
    let handleCalls = 0;
    const monitor = new BatchProcessMonitor(
      () => [target(101, [])],
      {
        handleSampleInterval: 3,
        pidusage: async () => {
          usageCalls++;
          return { 101: { cpu: 1, memory: 1000 } };
        },
        readHandles: async () => {
          handleCalls++;
          return 1;
        },
      }
    );

    await monitor.collectOnce();
    await monitor.collectOnce();
    await monitor.collectOnce();
    await monitor.collectOnce();

    expect(usageCalls).toBe(4);
    expect(handleCalls).toBe(process.platform === "linux" ? 2 : 0);
  });

  test("ignores stale PID samples after a process restarts", async () => {
    const container = Object.assign(Object.create(ProcessContainer.prototype), {
      status: "online",
      pid: 202,
      cpu: 0,
      memory: 0,
      handles: 0,
      config: {},
    }) as ProcessContainer;

    await container.applyMonitoringStats(
      101,
      { cpu: 50, memory: 5000 },
      10
    );
    expect(container.cpu).toBe(0);
    expect(container.memory).toBe(0);

    await container.applyMonitoringStats(
      202,
      { cpu: 25, memory: 2500 },
      5
    );
    expect(container.cpu).toBe(25);
    expect(container.memory).toBe(2500);
    expect(container.handles).toBe(5);
  });

  test("preserves max-memory restart behavior", async () => {
    let restarts = 0;
    const container = Object.assign(Object.create(ProcessContainer.prototype), {
      name: "memory-hog",
      status: "online",
      pid: 202,
      cpu: 0,
      memory: 0,
      handles: 0,
      config: { maxMemoryRestart: 2000 },
      restart: async () => {
        restarts++;
      },
    }) as ProcessContainer;

    await container.applyMonitoringStats(202, { cpu: 25, memory: 2501 });
    expect(restarts).toBe(1);
  });
});
