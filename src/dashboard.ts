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
import type { DashboardState } from "./types";
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

export async function buildDashboardClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "dashboard-app.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success || !result.outputs[0]) {
    const details = result.logs.map((log) => log.message).join("\n");
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

        // Serve dashboard HTML
        if (url.pathname !== "/") {
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
          this.clients.delete(ws);
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
        const logs = await this.pm.getLogs(msg.data.target, msg.data.lines || 50);
        ws.send(JSON.stringify({ type: "logs", data: logs }));
        break;
      }
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
        client.send(message);
      } catch {
        this.clients.delete(client);
      }
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
    this.clients.clear();
  }
}
