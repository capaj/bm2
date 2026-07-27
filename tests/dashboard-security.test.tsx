import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogRecord, ProcessTable } from "../src/dashboard-app";
import { getDashboardHTML } from "../src/dashboard-ui";
import type { ProcessState } from "../src/types";

const maliciousName = `"><img src=x onerror="globalThis.pwned=true">`;

const processState = {
  pm_id: 1,
  name: maliciousName,
  status: "online",
  pid: 123,
  monit: { cpu: 1, memory: 1024 },
  bm2_env: {
    restart_time: 0,
    pm_uptime: Date.now(),
  },
} as ProcessState;

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
});
