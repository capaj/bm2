import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogRecord, ProcessTable } from "../src/dashboard-app";
import {
  createCachedDashboardAsset,
  Dashboard,
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
      <ProcessTable
        processes={[processState]}
        send={() => {}}
        viewLogs={() => {}}
      />
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("onclick=");
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
