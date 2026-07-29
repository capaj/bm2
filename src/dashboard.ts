/**
 * BM2 — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://github.com/your-org/bm2
 * License: GPL-3.0-only
 * Author: Zak <zak@maxxpainn.com>
 */

import { ProcessManager } from "./process-manager";
import { getDashboardHTML } from "./dashboard-ui";
import { DASHBOARD_PORT, METRICS_PORT } from "./constants";
import type { Server, ServerWebSocket } from "bun";
import { join } from "path";
import type { DashboardState, LogItem } from "./types";
import { createHash } from "crypto";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "zlib";

export interface CachedDashboardAsset {
  identity: Uint8Array;
  gzip: Uint8Array;
  brotli: Uint8Array;
  etag: string;
}

export const DASHBOARD_LOG_BATCH_INTERVAL_MS = 100;
export const DASHBOARD_LOG_BATCH_MAX_BYTES = 128 * 1024;
export const DASHBOARD_LOG_MAX_BATCHES_PER_FLUSH = 4;
export const DASHBOARD_LOG_ENTRY_MAX_BYTES = 32 * 1024;
export const DASHBOARD_LOG_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
export const DASHBOARD_LOG_QUEUE_MAX_ENTRIES = 4096;
export const DASHBOARD_LOG_SNAPSHOT_MAX_BYTES = 256 * 1024;
export const DASHBOARD_WS_BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;
export const DASHBOARD_WS_BUFFERED_PAUSE_BYTES = 256 * 1024;

export function isDashboardPagePath(pathname: string): boolean {
  return pathname === "/" || /^\/process\/[^/]+\/?$/.test(pathname);
}

interface QueuedDashboardLog {
  serialized: string;
  bytes: number;
}

interface DashboardLogSubscription {
  controller: AbortController;
  target: string | number;
  queue: QueuedDashboardLog[];
  queueHead: number;
  queuedBytes: number;
  dropped: number;
  blocked: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function serializeDashboardLog(log: LogItem): QueuedDashboardLog {
  const safeLog: LogItem = {
    id: Number.isFinite(log.id) ? log.id : -1,
    name: String(log.name).slice(0, 1024),
    ts: String(log.ts).slice(0, 128),
    msg: String(log.msg),
    level: log.level === "err" ? "err" : "out",
  };
  let serialized = JSON.stringify(safeLog);
  let bytes = byteLength(serialized);
  if (bytes <= DASHBOARD_LOG_ENTRY_MAX_BYTES) return { serialized, bytes };

  const suffix = "\n[bm2 dashboard: oversized log entry truncated]";
  let low = 0;
  let high = safeLog.msg.length;
  let best = JSON.stringify({ ...safeLog, msg: suffix });

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      ...safeLog,
      msg: safeLog.msg.slice(0, middle) + suffix,
    });
    if (byteLength(candidate) <= DASHBOARD_LOG_ENTRY_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  serialized = best;
  bytes = byteLength(serialized);
  return { serialized, bytes };
}

export function createCachedDashboardAsset(source: string): CachedDashboardAsset {
  const identity = new TextEncoder().encode(source);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return {
    identity,
    gzip: gzipSync(identity, { level: 6 }),
    brotli: brotliCompressSync(identity, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    }),
    etag: `W/"${digest}"`,
  };
}

function acceptedEncodingQuality(header: string, encoding: string): number {
  let wildcardQuality = 0;
  for (const value of header.toLowerCase().split(",")) {
    const [name, ...parameters] = value.trim().split(";");
    const qualityParameter = parameters.find((parameter) =>
      parameter.trim().startsWith("q=")
    );
    const quality = qualityParameter
      ? Number.parseFloat(qualityParameter.trim().slice(2))
      : 1;
    const normalizedQuality = Number.isFinite(quality) ? quality : 0;
    if (name === encoding) return normalizedQuality;
    if (name === "*") wildcardQuality = normalizedQuality;
  }
  return wildcardQuality;
}

export function serveCachedDashboardAsset(
  request: Request,
  asset: CachedDashboardAsset,
  contentType: string
): Response {
  const acceptEncoding = request.headers.get("accept-encoding") || "";
  const brotliQuality = acceptedEncodingQuality(acceptEncoding, "br");
  const gzipQuality = acceptedEncodingQuality(acceptEncoding, "gzip");
  const encoding =
    brotliQuality > 0 && brotliQuality >= gzipQuality
      ? "br"
      : gzipQuality > 0
        ? "gzip"
        : null;
  const headers = new Headers({
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Content-Type": contentType,
    ETag: asset.etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  });
  if (encoding) headers.set("Content-Encoding", encoding);

  const validators = (request.headers.get("if-none-match") || "")
    .split(",")
    .map((value) => value.trim());
  if (validators.includes(asset.etag) || validators.includes("*")) {
    return new Response(null, { status: 304, headers });
  }

  const body =
    encoding === "br"
      ? asset.brotli
      : encoding === "gzip"
        ? asset.gzip
        : asset.identity;
  headers.set("Content-Length", String(body.byteLength));
  return new Response(body as unknown as BodyInit, { headers });
}

interface DashboardBuildDiagnostic {
  message?: unknown;
  position?: {
    file?: unknown;
    line?: unknown;
    column?: unknown;
    lineText?: unknown;
  } | null;
}

function formatDashboardBuildDiagnostic(
  diagnostic: DashboardBuildDiagnostic,
): string {
  const message =
    typeof diagnostic.message === "string"
      ? diagnostic.message
      : String(diagnostic);
  const position = diagnostic.position;
  const file = typeof position?.file === "string" ? position.file : null;
  const line = typeof position?.line === "number" ? position.line : null;
  const column =
    typeof position?.column === "number" ? position.column : null;
  const lineText =
    typeof position?.lineText === "string" ? position.lineText.trimEnd() : null;

  const location =
    file && line !== null
      ? `\n  at ${file}:${line}${column !== null ? `:${column}` : ""}`
      : "";
  const source = lineText ? `\n  ${lineText}` : "";
  return `${message}${location}${source}`;
}

export function formatDashboardBuildError(error: unknown): string {
  if (error && typeof error === "object") {
    const diagnostics = (error as { errors?: unknown }).errors;
    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
      return diagnostics
        .map((diagnostic) =>
          formatDashboardBuildDiagnostic(
            diagnostic as DashboardBuildDiagnostic,
          ),
        )
        .join("\n");
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export async function buildDashboardClient(): Promise<string> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [join(import.meta.dir, "dashboard-app.tsx")],
      target: "browser",
      format: "esm",
      minify: true,
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to build the dashboard client:\n${formatDashboardBuildError(error)}`,
    );
  }

  if (!result.success || !result.outputs[0]) {
    const details = result.logs
      .map((log) => formatDashboardBuildDiagnostic(log))
      .join("\n");
    throw new Error(`Failed to build the dashboard client${details ? `:\n${details}` : ""}`);
  }

  return result.outputs[0].text();
}

export class Dashboard {

  private server: Server<unknown> | null = null;
  private metricsServer: Server<unknown> | null = null;
  private clientAsset: CachedDashboardAsset | null = null;
  private stylesheetAsset: CachedDashboardAsset | null = null;

  private clients: Set<ServerWebSocket<unknown>> = new Set();
  private logSubscriptions: Map<
    ServerWebSocket<unknown>,
    DashboardLogSubscription
  > = new Map();
  private pm: ProcessManager;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(pm: ProcessManager) {
    this.pm = pm;
  }

  async start(port: number = DASHBOARD_PORT, metricsPort: number = METRICS_PORT) {
    if (!this.clientAsset || !this.stylesheetAsset) {
      const [clientBundle, stylesheet] = await Promise.all([
        buildDashboardClient(),
        Bun.file(join(import.meta.dir, "dashboard.css")).text(),
      ]);
      this.clientAsset = createCachedDashboardAsset(clientBundle);
      this.stylesheetAsset = createCachedDashboardAsset(stylesheet);
    }

    // Dashboard + WebSocket server
    this.server = Bun.serve<unknown>({
      port,
      fetch: (req, server) => {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: undefined })) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/api/processes") {
          return Response.json(this.pm.listDashboard());
        }

        if (url.pathname === "/api/metrics") {
          const metrics = this.pm.monitor.getLatest();
          return Response.json(metrics);
        }

        if (url.pathname === "/api/metrics/history") {
          const seconds = parseInt(url.searchParams.get("seconds") || "300");
          return Response.json(this.pm.getMetricsHistory(seconds));
        }

        if (url.pathname === "/api/prometheus" || url.pathname === "/metrics") {
          return new Response(this.pm.getPrometheusMetrics(), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }

        if (url.pathname === "/dashboard.js") {
          return serveCachedDashboardAsset(
            req,
            this.clientAsset!,
            "text/javascript; charset=utf-8"
          );
        }

        if (url.pathname === "/dashboard.css") {
          return serveCachedDashboardAsset(
            req,
            this.stylesheetAsset!,
            "text/css; charset=utf-8"
          );
        }

        // Action endpoints
        if (req.method === "POST") {
          return this.handleAction(url.pathname, req);
        }

        // Serve the React shell for dashboard routes so direct links and
        // browser refreshes can be resolved client-side by wouter.
        if (!isDashboardPagePath(url.pathname)) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(getDashboardHTML(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": [
              "default-src 'self'",
              "script-src 'self'",
              "connect-src 'self' ws: wss:",
              "style-src 'self'",
              "img-src 'self' data:",
              "object-src 'none'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
      websocket: {
        backpressureLimit: DASHBOARD_WS_BACKPRESSURE_LIMIT_BYTES,
        closeOnBackpressureLimit: false,
        open: (ws) => {
          this.clients.add(ws);
          ws.send(JSON.stringify({ type: "state", data: this.getState() }));
        },
        message: async (ws, message) => {
          try {
            const msg = JSON.parse(String(message));
            await this.handleWsMessage(ws, msg);
          } catch {}
        },
        close: (ws) => {
          this.stopLogSubscription(ws);
          this.clients.delete(ws);
        },
        drain: (ws) => {
          const subscription = this.logSubscriptions.get(ws);
          if (subscription) subscription.blocked = false;
          this.flushLogBatches(ws);
        },
      },
    });

    // Separate Prometheus metrics server
    this.metricsServer = Bun.serve({
      port: metricsPort,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/metrics") {
          return new Response(this.pm.getPrometheusMetrics(), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("BM2 Metrics Server\nGET /metrics for Prometheus format", {
          status: 200,
        });
      },
    });

    // The daemon owns metric collection. The dashboard only publishes the
    // latest snapshot, avoiding a second history entry every two seconds.
    this.updateInterval = setInterval(() => this.broadcast(), 2000);

    console.log(`[bm2] Dashboard running at http://localhost:${port}`);
    console.log(`[bm2] Prometheus metrics at http://localhost:${metricsPort}/metrics`);
  }

  private async handleAction(pathname: string, req: Request): Promise<Response> {
    try {

        const body = (await req.json()) as { target?: string; count?: number };

      switch (pathname) {
        case "/api/restart":
          return Response.json(await this.pm.restart(body.target || "all"));
        case "/api/stop":
          return Response.json(await this.pm.stop(body.target || "all"));
        case "/api/reload":
          return Response.json(await this.pm.reload(body.target || "all"));
        case "/api/delete":
          return Response.json(await this.pm.del(body.target!));
        case "/api/scale":
          return Response.json(await this.pm.scale(body.target!, body.count!));
        case "/api/flush":
          await this.pm.flushLogs(body.target);
          return Response.json({ success: true });
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  private async handleWsMessage(ws: ServerWebSocket<unknown>, msg: any) {
    switch (msg.type) {
      case "getState": {
        ws.send(JSON.stringify({ type: "state", data: this.getState() }));
        break;
      }
      case "getLogs": {
        const requestedTarget = msg.data?.target;
        if (requestedTarget === undefined || requestedTarget === null) break;
        const target =
          typeof requestedTarget === "number" &&
          Number.isFinite(requestedTarget)
            ? requestedTarget
            : String(requestedTarget).slice(0, 128);

        this.stopLogSubscription(ws);
        const controller = new AbortController();
        const subscription: DashboardLogSubscription = {
          controller,
          target,
          queue: [],
          queueHead: 0,
          queuedBytes: 0,
          dropped: 0,
          blocked: false,
          flushTimer: null,
        };
        this.logSubscriptions.set(ws, subscription);
        const requestedLines = Number(msg.data?.lines) || 50;
        const lines = Math.trunc(
          Math.min(1000, Math.max(1, requestedLines))
        );

        const isCurrent = () =>
          !controller.signal.aborted &&
          this.logSubscriptions.get(ws) === subscription;

        const sendSnapshot = (logs: LogItem[]) => {
          if (!isCurrent()) return;

          const normalized = logs.map(serializeDashboardLog);
          const retained: QueuedDashboardLog[] = [];
          let retainedBytes = 0;
          for (let index = normalized.length - 1; index >= 0; index--) {
            const entry = normalized[index]!;
            if (
              retained.length > 0 &&
              retainedBytes + entry.bytes > DASHBOARD_LOG_SNAPSHOT_MAX_BYTES
            ) {
              break;
            }
            retained.unshift(entry);
            retainedBytes += entry.bytes;
          }

          const omitted = normalized.length - retained.length;
          if (omitted > 0) {
            const reference = logs.at(-1);
            const marker = serializeDashboardLog({
              id:
                reference?.id ??
                (typeof target === "number" ? target : -1),
              name: reference?.name ?? String(target),
              ts: new Date().toISOString(),
              level: "out",
              msg: `[bm2 dashboard: ${omitted} earlier log entries omitted from the initial view]`,
            });
            while (
              retained.length > 0 &&
              retainedBytes + marker.bytes >
                DASHBOARD_LOG_SNAPSHOT_MAX_BYTES
            ) {
              retainedBytes -= retained.shift()!.bytes;
            }
            retained.unshift(marker);
          }

          const payload =
            `{"type":"logs","target":${JSON.stringify(target)},"data":[` +
            retained.map(({ serialized }) => serialized).join(",") +
            "]}";

          if (
            typeof ws.getBufferedAmount === "function" &&
            ws.getBufferedAmount() > DASHBOARD_WS_BUFFERED_PAUSE_BYTES
          ) {
            subscription.dropped += logs.length;
            this.scheduleLogFlush(ws, subscription);
            return;
          }

          try {
            const status = ws.send(payload);
            if (status === 0) {
              this.stopLogSubscription(ws);
              this.clients.delete(ws);
            } else if (status === -1) {
              subscription.blocked = true;
            }
          } catch {
            this.stopLogSubscription(ws);
            this.clients.delete(ws);
          }
        };

        try {
          await this.pm.subscribeLogs(
            target,
            lines,
            sendSnapshot,
            (log) => {
              if (isCurrent()) this.enqueueLog(ws, subscription, log);
            },
            controller.signal
          );
        } catch (error) {
          if (this.logSubscriptions.get(ws) === subscription) {
            this.stopLogSubscription(ws);
          }
          throw error;
        }
        break;
      }
      case "stopLogs":
        this.stopLogSubscription(ws);
        break;
      case "restart":
        await this.pm.restart(msg.data.target);
        break;
      case "stop":
        await this.pm.stop(msg.data.target);
        break;
      case "reload":
        await this.pm.reload(msg.data.target);
        break;
      case "scale":
        await this.pm.scale(msg.data.target, msg.data.count);
        break;
    }
  }

  private broadcast() {
    const message = JSON.stringify({ type: "state", data: this.getState() });
    for (const client of this.clients) {
      try {
        const status = client.send(message);
        if (status === 0) {
          this.stopLogSubscription(client);
          this.clients.delete(client);
        } else if (status === -1) {
          const subscription = this.logSubscriptions.get(client);
          if (subscription) subscription.blocked = true;
        }
      } catch {
        this.stopLogSubscription(client);
        this.clients.delete(client);
      }
    }
  }

  private stopLogSubscription(ws: ServerWebSocket<unknown>) {
    const subscription = this.logSubscriptions.get(ws);
    if (!subscription) return;
    subscription.controller.abort();
    if (subscription.flushTimer) clearTimeout(subscription.flushTimer);
    this.logSubscriptions.delete(ws);
  }

  private enqueueLog(
    ws: ServerWebSocket<unknown>,
    subscription: DashboardLogSubscription,
    log: LogItem
  ) {
    const queued = serializeDashboardLog(log);

    while (
      (subscription.queuedBytes + queued.bytes >
        DASHBOARD_LOG_QUEUE_MAX_BYTES ||
        subscription.queue.length - subscription.queueHead >=
          DASHBOARD_LOG_QUEUE_MAX_ENTRIES) &&
      subscription.queueHead < subscription.queue.length
    ) {
      const dropped = subscription.queue[subscription.queueHead++]!;
      subscription.queuedBytes -= dropped.bytes;
      subscription.dropped++;
    }

    subscription.queue.push(queued);
    subscription.queuedBytes += queued.bytes;
    this.compactLogQueue(subscription);
    this.scheduleLogFlush(ws, subscription);
  }

  private scheduleLogFlush(
    ws: ServerWebSocket<unknown>,
    subscription: DashboardLogSubscription
  ) {
    if (
      subscription.flushTimer ||
      subscription.blocked ||
      this.logSubscriptions.get(ws) !== subscription
    ) {
      return;
    }
    subscription.flushTimer = setTimeout(() => {
      subscription.flushTimer = null;
      this.flushLogBatches(ws);
    }, DASHBOARD_LOG_BATCH_INTERVAL_MS);
  }

  private flushLogBatches(ws: ServerWebSocket<unknown>) {
    const subscription = this.logSubscriptions.get(ws);
    if (
      !subscription ||
      subscription.controller.signal.aborted ||
      subscription.blocked
    ) {
      return;
    }

    if (subscription.flushTimer) {
      clearTimeout(subscription.flushTimer);
      subscription.flushTimer = null;
    }

    try {
      if (
        typeof ws.getBufferedAmount === "function" &&
        ws.getBufferedAmount() > DASHBOARD_WS_BUFFERED_PAUSE_BYTES
      ) {
        this.scheduleLogFlush(ws, subscription);
        return;
      }

      const sendBatches = () => {
        for (
          let batchIndex = 0;
          batchIndex < DASHBOARD_LOG_MAX_BATCHES_PER_FLUSH;
          batchIndex++
        ) {
          const available =
            subscription.queue.length - subscription.queueHead;
          if (available === 0 && subscription.dropped === 0) break;

          let batchBytes = 0;
          let batchCount = 0;
          while (batchCount < available) {
            const entry =
              subscription.queue[subscription.queueHead + batchCount]!;
            const projectedBytes =
              batchBytes + entry.bytes + (batchCount === 0 ? 0 : 1);
            if (
              batchCount > 0 &&
              projectedBytes > DASHBOARD_LOG_BATCH_MAX_BYTES - 512
            ) {
              break;
            }
            batchBytes = projectedBytes;
            batchCount++;
          }

          const entries = subscription.queue
            .slice(
              subscription.queueHead,
              subscription.queueHead + batchCount
            )
            .map(({ serialized }) => serialized)
            .join(",");
          const dropped = subscription.dropped;
          const payload =
            `{"type":"logBatch","target":${JSON.stringify(subscription.target)},` +
            `"data":{"entries":[${entries}],"dropped":${dropped}}}`;
          const status = ws.send(payload);

          if (status === 0) {
            this.stopLogSubscription(ws);
            this.clients.delete(ws);
            break;
          }

          this.dequeueLogs(subscription, batchCount);
          subscription.dropped = 0;

          if (status === -1) {
            subscription.blocked = true;
            break;
          }
          if (
            typeof ws.getBufferedAmount === "function" &&
            ws.getBufferedAmount() > DASHBOARD_WS_BUFFERED_PAUSE_BYTES
          ) {
            break;
          }
        }
      };

      if (typeof ws.cork === "function") {
        ws.cork(() => sendBatches());
      } else {
        sendBatches();
      }
    } catch {
      this.stopLogSubscription(ws);
      this.clients.delete(ws);
      return;
    }

    if (
      subscription.queueHead < subscription.queue.length ||
      subscription.dropped > 0
    ) {
      this.scheduleLogFlush(ws, subscription);
    }
  }

  private dequeueLogs(
    subscription: DashboardLogSubscription,
    count: number
  ) {
    const end = subscription.queueHead + count;
    for (
      let index = subscription.queueHead;
      index < end;
      index++
    ) {
      subscription.queuedBytes -= subscription.queue[index]!.bytes;
    }
    subscription.queueHead = end;
    this.compactLogQueue(subscription);
  }

  private compactLogQueue(subscription: DashboardLogSubscription) {
    if (
      subscription.queueHead > 0 &&
      (subscription.queueHead >= 1024 ||
        subscription.queueHead * 2 >= subscription.queue.length)
    ) {
      subscription.queue = subscription.queue.slice(subscription.queueHead);
      subscription.queueHead = 0;
    }
  }

  private getState(): DashboardState {
    const latestMetrics = this.pm.monitor.getLatest();
    return {
      processes: this.pm.listDashboard(),
      system: latestMetrics?.system ?? null,
      timestamp: latestMetrics?.timestamp ?? Date.now(),
    };
  }

  stop() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.server) this.server.stop();
    if (this.metricsServer) this.metricsServer.stop();
    for (const subscription of this.logSubscriptions.values()) {
      subscription.controller.abort();
      if (subscription.flushTimer) clearTimeout(subscription.flushTimer);
    }
    this.logSubscriptions.clear();
    this.clients.clear();
  }
}
