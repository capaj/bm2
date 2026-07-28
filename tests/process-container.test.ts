import { describe, expect, test } from "bun:test";
import { ProcessContainer } from "../src/process-container";

function createExitTestContainer(options: {
  maxRestarts: number;
  minUptime: number;
  restartCount: number;
  unstableRestarts: number;
  uptime: number;
}): ProcessContainer {
  return Object.assign(Object.create(ProcessContainer.prototype), {
    name: "restart-test",
    status: "online",
    pid: 123,
    process: {},
    startedAt: Date.now() - options.uptime,
    restartCount: options.restartCount,
    unstableRestarts: options.unstableRestarts,
    restartTimer: null,
    config: {
      autorestart: true,
      maxRestarts: options.maxRestarts,
      minUptime: options.minUptime,
      restartDelay: 60_000,
    },
    cleanupTimers: () => {},
    start: async () => {},
  }) as ProcessContainer;
}

function clearRestartTimer(container: ProcessContainer): void {
  const timer = (container as any).restartTimer;
  if (timer) clearTimeout(timer);
}

describe("ProcessContainer restart budget", () => {
  test("resets the consecutive restart budget after a stable run", () => {
    const container = createExitTestContainer({
      maxRestarts: 3,
      minUptime: 1_000,
      restartCount: 23,
      unstableRestarts: 3,
      uptime: 1_001,
    });

    try {
      (container as any).handleExit(1);

      expect(container.status).toBe("waiting-restart");
      expect(container.unstableRestarts).toBe(0);
      expect(container.restartCount).toBe(23);
    } finally {
      clearRestartTimer(container);
    }
  });

  test("stops after maxRestarts consecutive unstable exits", () => {
    const container = createExitTestContainer({
      maxRestarts: 3,
      minUptime: 1_000,
      restartCount: 1,
      unstableRestarts: 3,
      uptime: 999,
    });

    try {
      (container as any).handleExit(1);

      expect(container.status).toBe("errored");
      expect(container.unstableRestarts).toBe(3);
      expect(container.restartCount).toBe(1);
    } finally {
      clearRestartTimer(container);
    }
  });
});
