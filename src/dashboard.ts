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
  private clientBundle: string | null = null;

  private clients: Set<ServerWebSocket<unknown>> = new Set();
  private pm: ProcessManager;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(pm: ProcessManager) {
    this.pm = pm;
  }

  async start(port: number = DASHBOARD_PORT, metricsPort: number = METRICS_PORT) {
    this.clientBundle ??= await buildDashboardClient();

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
          return Response.json(this.pm.list());
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
          return new Response(this.clientBundle, {
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        if (url.pathname === "/dashboard.css") {
          return new Response(Bun.file(join(import.meta.dir, "dashboard.css")), {
            headers: {
              "Content-Type": "text/css; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          });
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
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          // Send initial state
          const state = {
            processes: this.pm.list(),
            metrics: this.pm.monitor.getLatest(),
          };
          ws.send(JSON.stringify({ type: "state", data: state }));
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

    // Periodic broadcast
    this.updateInterval = setInterval(async () => {
      await this.pm.getMetrics(); // Collect snapshot
      this.broadcast();
    }, 2000);

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
        const state = {
          processes: this.pm.list(),
          metrics: this.pm.monitor.getLatest(),
        };
        ws.send(JSON.stringify({ type: "state", data: state }));
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
    const state = {
      processes: this.pm.list(),
      metrics: this.pm.monitor.getLatest(),
    };
    const message = JSON.stringify({ type: "state", data: state });
    for (const client of this.clients) {
      try {
        client.send(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  stop() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.server) this.server.stop();
    if (this.metricsServer) this.metricsServer.stop();
    this.clients.clear();
  }
}
