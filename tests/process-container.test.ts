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

describe("ProcessContainer output framing", () => {
  test("preserves complete lines across arbitrary UTF-8 pipe chunks", async () => {
    const batches: string[][] = [];
    const trailing: string[] = [];
    const container = Object.assign(Object.create(ProcessContainer.prototype), {
      logManager: {
        appendJSONLogs: (_filePath: string, messages: readonly string[]) => {
          batches.push([...messages]);
        },
        appendJSONLog: (_filePath: string, message: string) => {
          trailing.push(message);
        },
      },
    }) as ProcessContainer;
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode("  hel"),
      encoder.encode("lo 🌍\r\nsecond"),
      encoder.encode(" line\n\nunterminated tail  "),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    await (container as any).pipeStream(stream, "out.log");

    expect(batches.flat()).toEqual(["  hello 🌍", "second line", ""]);
    expect(trailing).toEqual(["unterminated tail  "]);
  });

  test("bounds newline-free output without dropping content", async () => {
    const messages: string[] = [];
    const container = Object.assign(Object.create(ProcessContainer.prototype), {
      logManager: {
        appendJSONLogs: (_filePath: string, batch: readonly string[]) => {
          messages.push(...batch);
        },
        appendJSONLog: (_filePath: string, message: string) => {
          messages.push(message);
        },
      },
    }) as ProcessContainer;
    const content = "🌍".repeat(50_000);
    const encoded = new TextEncoder().encode(content);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 997) {
          controller.enqueue(encoded.slice(offset, offset + 997));
        }
        controller.close();
      },
    });

    await (container as any).pipeStream(stream, "out.log");

    expect(messages.join("")).toBe(content);
    expect(Math.max(...messages.map(({ length }) => length))).toBeLessThanOrEqual(
      8 * 1024
    );
  });
});
