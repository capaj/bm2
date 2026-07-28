import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import {
  createLogBuffer,
  DashboardRoutes,
  LogRecord,
  parseProcessId,
  ProcessTable,
} from "../src/dashboard-app";
import {
  createCachedDashboardAsset,
  Dashboard,
  DASHBOARD_LOG_BATCH_INTERVAL_MS,
  DASHBOARD_LOG_BATCH_MAX_BYTES,
  DASHBOARD_LOG_ENTRY_MAX_BYTES,
  DASHBOARD_LOG_QUEUE_MAX_BYTES,
  DASHBOARD_LOG_QUEUE_MAX_ENTRIES,
  DASHBOARD_LOG_SNAPSHOT_MAX_BYTES,
  isDashboardPagePath,
  serializeDashboardLog,
  serveCachedDashboardAsset,
} from "../src/dashboard";
import { getDashboardHTML } from "../src/dashboard-ui";
import { ProcessManager } from "../src/process-manager";
import type { DashboardProcessState } from "../src/types";

const maliciousName = `"><img src=x onerror="globalThis.pwned=true">`;

const processState = {
  pm_id: 1,
  name: maliciousName,
  status: "online",
  pid: 123,
  cpu: 1,
  memory: 1024,
  restarts: 0,
  startedAt: Date.now(),
} satisfies DashboardProcessState;

describe("dashboard XSS protection", () => {
  test("renders process names as escaped React text", () => {
    const markup = renderToStaticMarkup(
      <Router ssrPath="/">
        <ProcessTable
          openProcess={() => {}}
          processes={[processState]}
          send={() => {}}
        />
      </Router>
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("onclick=");
    expect(markup).toContain('href="/process/1"');
  });

  test("renders log output as escaped React text", () => {
    const markup = renderToStaticMarkup(
      <div>
        <LogRecord
          log={{
            id: 1,
            name: "malicious",
            level: "out",
            msg: `</span><img src=x onerror=alert(1)>`,
            ts: "now",
          }}
        />
      </div>
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain('<span class="timestamp">[now] </span>');
  });

  test("serves a static shell with no inline JavaScript", () => {
    const html = getDashboardHTML();

    expect(html).toContain('<script type="module" src="/dashboard.js"></script>');
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("onclick=");
  });

  test("recognizes overview and process-detail paths as React routes", () => {
    expect(isDashboardPagePath("/")).toBe(true);
    expect(isDashboardPagePath("/process/0")).toBe(true);
    expect(isDashboardPagePath("/process/42/")).toBe(true);
    expect(isDashboardPagePath("/process/not-a-number")).toBe(false);
    expect(isDashboardPagePath("/dashboard.js")).toBe(false);
  });

  test("renders a routed process detail with the expanded live-log panel", () => {
    const markup = renderToStaticMarkup(
      <Router ssrPath="/process/1">
        <DashboardRoutes
          dashboardState={{
            processes: [processState],
            system: null,
            timestamp: Date.now(),
          }}
          hasDashboardState
          logBuffer={createLogBuffer()}
          send={() => {}}
          subscribeToLogs={() => {}}
          unsubscribeFromLogs={() => {}}
        />
      </Router>
    );

    expect(markup).toContain("Live logs");
    expect(markup).toContain("Back to processes");
    expect(markup).toContain("logs-panel-expanded");
    expect(markup).not.toContain("CPU &amp; Memory Over Time");
    expect(markup).not.toContain("<img");
  });

  test("validates process IDs before selecting a process", () => {
    expect(parseProcessId("0")).toBe(0);
    expect(parseProcessId("42")).toBe(42);
    expect(parseProcessId("-1")).toBeNull();
    expect(parseProcessId("1.5")).toBeNull();
    expect(parseProcessId("process-name")).toBeNull();
  });

  test("dashboard process payloads exclude executable config and environment data", () => {
    const manager = new ProcessManager();
    (manager as any).processes.set(1, {
      getDashboardState: () => processState,
      getState: () => {
        throw new Error("full process state should not be constructed");
      },
    });

    const payload = JSON.stringify(manager.listDashboard());
    expect(JSON.parse(payload)[0].name).toBe(maliciousName);
    expect(payload).not.toContain("bm2_env");
    expect(payload).not.toContain("env");
  });

  test("broadcasts the latest snapshot without collecting duplicate metrics", () => {
    let metricCollections = 0;
    let message = "";
    const dashboard = new Dashboard({
      listDashboard: () => [processState],
      monitor: { getLatest: () => null },
      getMetrics: () => {
        metricCollections++;
      },
    } as any);
    (dashboard as any).clients.add({
      send: (value: string) => {
        message = value;
      },
    });

    (dashboard as any).broadcast();
    expect(metricCollections).toBe(0);
    expect(JSON.parse(message).data.processes).toHaveLength(1);
  });

  test("streams logs and cancels stale process subscriptions", async () => {
    const subscriptions: Array<{
      signal: AbortSignal;
      onLog: (log: any) => void;
    }> = [];
    const messages: any[] = [];
    const dashboard = new Dashboard({
      subscribeLogs: async (
        target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        onLog: (log: any) => void,
        signal: AbortSignal
      ) => {
        subscriptions.push({ signal, onLog });
        onSnapshot([
          { id: target, name: `process-${target}`, ts: "snapshot", msg: "old" },
        ]);
      },
    } as any);
    const socket: any = {
      send: (message: string) => {
        messages.push(JSON.parse(message));
        return Buffer.byteLength(message);
      },
      getBufferedAmount: () => 0,
      cork: (callback: (ws: any) => void) => callback(socket),
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    expect(messages[0]).toMatchObject({
      type: "logs",
      target: 1,
      data: [{ id: 1, msg: "old" }],
    });

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 2, lines: 50 },
    });
    expect(subscriptions[0]!.signal.aborted).toBe(true);

    subscriptions[0]!.onLog({
      id: 1,
      name: "process-1",
      ts: "stale",
      msg: "ignore me",
    });
    subscriptions[1]!.onLog({
      id: 2,
      name: "process-2",
      ts: "live",
      msg: "streamed",
    });
    (dashboard as any).flushLogBatches(socket);

    expect(messages.at(-1)).toMatchObject({
      type: "logBatch",
      target: 2,
      data: {
        dropped: 0,
        entries: [{ id: 2, msg: "streamed" }],
      },
    });
    expect(
      messages.some(
        ({ data }) =>
          Array.isArray(data?.entries) &&
          data.entries.some(({ msg }: any) => msg === "ignore me")
      )
    ).toBe(false);

    dashboard.stop();
    expect(subscriptions[1]!.signal.aborted).toBe(true);
  });

  test("stops the server log stream when leaving process detail", async () => {
    let signal: AbortSignal | undefined;
    const dashboard = new Dashboard({
      subscribeLogs: async (
        _target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        _onLog: (log: any) => void,
        streamSignal: AbortSignal
      ) => {
        signal = streamSignal;
        onSnapshot([]);
      },
    } as any);
    const socket: any = {
      send: (message: string) => Buffer.byteLength(message),
      getBufferedAmount: () => 0,
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    expect(signal?.aborted).toBe(false);

    await (dashboard as any).handleWsMessage(socket, { type: "stopLogs" });

    expect(signal?.aborted).toBe(true);
    expect((dashboard as any).logSubscriptions.has(socket)).toBe(false);
  });

  test("bounds queued logs and reports entries dropped under backpressure", async () => {
    let onLog: ((log: any) => void) | undefined;
    const messages: any[] = [];
    let bufferedAmount = DASHBOARD_LOG_QUEUE_MAX_BYTES;
    const dashboard = new Dashboard({
      subscribeLogs: async (
        _target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        liveLog: (log: any) => void
      ) => {
        onLog = liveLog;
        onSnapshot([]);
      },
    } as any);
    const socket: any = {
      send: (message: string) => {
        messages.push(JSON.parse(message));
        return Buffer.byteLength(message);
      },
      getBufferedAmount: () => bufferedAmount,
      cork: (callback: (ws: any) => void) => callback(socket),
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    for (let index = 0; index < DASHBOARD_LOG_QUEUE_MAX_ENTRIES + 100; index++) {
      onLog!({
        id: 1,
        name: "noisy",
        ts: String(index),
        msg: `entry-${index}`,
        level: "out",
      });
    }

    const subscription = (dashboard as any).logSubscriptions.get(socket);
    expect(subscription.queue.length - subscription.queueHead).toBeLessThanOrEqual(
      DASHBOARD_LOG_QUEUE_MAX_ENTRIES
    );
    expect(subscription.queuedBytes).toBeLessThanOrEqual(
      DASHBOARD_LOG_QUEUE_MAX_BYTES
    );
    expect(subscription.dropped).toBe(100);

    (dashboard as any).flushLogBatches(socket);
    expect(messages).toHaveLength(0);

    bufferedAmount = 0;
    (dashboard as any).flushLogBatches(socket);
    const batches = messages.filter(({ type }) => type === "logBatch");
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].data.dropped).toBe(100);
    expect(
      batches.flatMap(({ data }) => data.entries).at(-1).msg
    ).toBe(`entry-${DASHBOARD_LOG_QUEUE_MAX_ENTRIES + 99}`);

    dashboard.stop();
  });

  test("coalesces live entries into one timed WebSocket batch", async () => {
    let onLog: ((log: any) => void) | undefined;
    const messages: any[] = [];
    const dashboard = new Dashboard({
      subscribeLogs: async (
        _target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        liveLog: (log: any) => void
      ) => {
        onLog = liveLog;
        onSnapshot([]);
      },
    } as any);
    const socket: any = {
      send: (message: string) => {
        messages.push(JSON.parse(message));
        return Buffer.byteLength(message);
      },
      getBufferedAmount: () => 0,
      cork: (callback: (ws: any) => void) => callback(socket),
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    messages.length = 0;
    for (let index = 0; index < 100; index++) {
      onLog!({
        id: 1,
        name: "noisy",
        ts: String(index),
        msg: `entry-${index}`,
        level: "out",
      });
    }

    expect(messages).toHaveLength(0);
    await Bun.sleep(DASHBOARD_LOG_BATCH_INTERVAL_MS + 20);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "logBatch",
      target: 1,
      data: { dropped: 0 },
    });
    expect(messages[0].data.entries).toHaveLength(100);

    dashboard.stop();
  });

  test("caps individual entries and WebSocket batch payloads", async () => {
    const oversized = serializeDashboardLog({
      id: 1,
      name: "noisy",
      ts: "now",
      msg: "x".repeat(DASHBOARD_LOG_ENTRY_MAX_BYTES * 4),
      level: "out",
    });
    expect(oversized.bytes).toBeLessThanOrEqual(
      DASHBOARD_LOG_ENTRY_MAX_BYTES
    );
    expect(JSON.parse(oversized.serialized).msg).toContain(
      "oversized log entry truncated"
    );

    let onLog: ((log: any) => void) | undefined;
    const payloads: string[] = [];
    const dashboard = new Dashboard({
      subscribeLogs: async (
        _target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        liveLog: (log: any) => void
      ) => {
        onLog = liveLog;
        onSnapshot([]);
      },
    } as any);
    const socket: any = {
      send: (message: string) => {
        payloads.push(message);
        return Buffer.byteLength(message);
      },
      getBufferedAmount: () => 0,
      cork: (callback: (ws: any) => void) => callback(socket),
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    payloads.length = 0;
    for (let index = 0; index < 20; index++) {
      onLog!({
        id: 1,
        name: "noisy",
        ts: String(index),
        msg: "x".repeat(DASHBOARD_LOG_ENTRY_MAX_BYTES * 2),
        level: "out",
      });
    }
    (dashboard as any).flushLogBatches(socket);

    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(
        DASHBOARD_LOG_BATCH_MAX_BYTES
      );
    }

    dashboard.stop();
  });

  test("consumes a backpressured batch once and resumes after drain", async () => {
    let onLog: ((log: any) => void) | undefined;
    const messages: any[] = [];
    let nextStatus = 1;
    const dashboard = new Dashboard({
      subscribeLogs: async (
        _target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        liveLog: (log: any) => void
      ) => {
        onLog = liveLog;
        onSnapshot([]);
      },
    } as any);
    const socket: any = {
      send: (message: string) => {
        messages.push(JSON.parse(message));
        const status = nextStatus;
        nextStatus = 1;
        return status;
      },
      getBufferedAmount: () => 0,
      cork: (callback: (ws: any) => void) => callback(socket),
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    messages.length = 0;

    onLog!({ id: 1, name: "noisy", ts: "1", msg: "first", level: "out" });
    nextStatus = -1;
    (dashboard as any).flushLogBatches(socket);
    const subscription = (dashboard as any).logSubscriptions.get(socket);
    expect(subscription.blocked).toBe(true);
    expect(subscription.queue.length - subscription.queueHead).toBe(0);

    onLog!({ id: 1, name: "noisy", ts: "2", msg: "second", level: "out" });
    (dashboard as any).flushLogBatches(socket);
    expect(messages).toHaveLength(1);

    subscription.blocked = false;
    (dashboard as any).flushLogBatches(socket);
    expect(messages).toHaveLength(2);
    expect(messages[0].data.entries.map(({ msg }: any) => msg)).toEqual([
      "first",
    ]);
    expect(messages[1].data.entries.map(({ msg }: any) => msg)).toEqual([
      "second",
    ]);

    dashboard.stop();
  });

  test("tears down a stream when Bun reports a dropped send", async () => {
    let onLog: ((log: any) => void) | undefined;
    let signal: AbortSignal | undefined;
    let dropNextSend = false;
    const dashboard = new Dashboard({
      subscribeLogs: async (
        _target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void,
        liveLog: (log: any) => void,
        streamSignal: AbortSignal
      ) => {
        onLog = liveLog;
        signal = streamSignal;
        onSnapshot([]);
      },
    } as any);
    const socket: any = {
      send: () => (dropNextSend ? 0 : 1),
      getBufferedAmount: () => 0,
      cork: (callback: (ws: any) => void) => callback(socket),
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });
    onLog!({ id: 1, name: "noisy", ts: "1", msg: "lost", level: "out" });
    dropNextSend = true;
    (dashboard as any).flushLogBatches(socket);

    expect(signal!.aborted).toBe(true);
    expect((dashboard as any).logSubscriptions.has(socket)).toBe(false);
  });

  test("bounds the initial snapshot by bytes and reports omitted history", async () => {
    let payload = "";
    const dashboard = new Dashboard({
      subscribeLogs: async (
        target: number,
        _lines: number,
        onSnapshot: (logs: any[]) => void
      ) => {
        onSnapshot(
          Array.from({ length: 50 }, (_, index) => ({
            id: target,
            name: "noisy",
            ts: String(index),
            msg: "x".repeat(DASHBOARD_LOG_ENTRY_MAX_BYTES),
            level: "out",
          }))
        );
      },
    } as any);
    const socket: any = {
      send: (message: string) => {
        payload = message;
        return Buffer.byteLength(message);
      },
      getBufferedAmount: () => 0,
    };

    await (dashboard as any).handleWsMessage(socket, {
      type: "getLogs",
      data: { target: 1, lines: 50 },
    });

    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(
      DASHBOARD_LOG_SNAPSHOT_MAX_BYTES + 256
    );
    const snapshot = JSON.parse(payload);
    expect(snapshot.data[0].msg).toContain(
      "earlier log entries omitted from the initial view"
    );
    expect(snapshot.data.at(-1).ts).toBe("49");

    dashboard.stop();
  });

  test("serves compressed assets and revalidates them with ETags", async () => {
    const asset = createCachedDashboardAsset("const value = 'dashboard';".repeat(100));
    const compressed = serveCachedDashboardAsset(
      new Request("http://localhost/dashboard.js", {
        headers: { "Accept-Encoding": "gzip, br" },
      }),
      asset,
      "text/javascript; charset=utf-8"
    );

    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(compressed.headers.get("etag")).toBe(asset.etag);
    expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
    expect(Number(compressed.headers.get("content-length"))).toBe(
      asset.brotli.byteLength
    );
    expect(asset.brotli.byteLength).toBeLessThan(asset.identity.byteLength);

    const notModified = serveCachedDashboardAsset(
      new Request("http://localhost/dashboard.js", {
        headers: {
          "Accept-Encoding": "gzip",
          "If-None-Match": asset.etag,
        },
      }),
      asset,
      "text/javascript; charset=utf-8"
    );
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
  });
});
