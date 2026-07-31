import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigHistoryStore } from "../src/config-history-store";
import { formatConfigReloadNotice } from "../src/config-reload-notice";
import { loadEcosystemConfigFile } from "../src/ecosystem-loader";
import { ProcessContainer } from "../src/process-container";
import { ProcessManager } from "../src/process-manager";
import type { ProcessDescription } from "../src/types";

const TEST_DIR = join(tmpdir(), `bm2-config-history-${process.pid}`);
const DATABASE_FILE = join(TEST_DIR, "config-history.sqlite");
const CONFIG_FILE = join(TEST_DIR, "bm2.config.json");
const SCRIPT_FILE = join(TEST_DIR, "service.ts");
const TYPESCRIPT_CONFIG_FILE = join(TEST_DIR, "bm2.config.ts");
const originalContainerStart = ProcessContainer.prototype.start;

let store: ConfigHistoryStore;
let managers: ProcessManager[];

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(SCRIPT_FILE, "await new Promise(() => {});\n");
  store = new ConfigHistoryStore(DATABASE_FILE);
  managers = [];

  ProcessContainer.prototype.start = async function (trigger) {
    const shouldStart = await (this as any).beforeStart?.(this, trigger);
    if (shouldStart === false) return;
    this.startedAt = Date.now();
    this.status = "online";
  };
});

afterEach(async () => {
  ProcessContainer.prototype.start = originalContainerStart;
  for (const manager of managers) {
    (manager as any).processMonitor.stop();
  }
  store.close();
  await rm(TEST_DIR, { recursive: true, force: true });
});

function completeConfig(overrides: Partial<ProcessDescription> = {}): ProcessDescription {
  return {
    id: 1,
    name: "service",
    script: SCRIPT_FILE,
    args: [],
    cwd: TEST_DIR,
    env: {},
    instances: 1,
    execMode: "fork",
    autorestart: true,
    maxRestarts: 15,
    minUptime: 30_000,
    watch: false,
    mergeLogs: false,
    killTimeout: 15_000,
    restartDelay: 10_000,
    ...overrides,
  };
}

describe("ConfigHistoryStore", () => {
  test("stores deduplicated snapshots with provenance and field changes", () => {
    const initial = completeConfig();
    const changed = completeConfig({
      args: ["--port", "5000"],
      restartDelay: 20_000,
    });

    store.record(initial, {
      source: "cli",
      trigger: "start",
      summary: "Started from CLI/API options",
    });
    store.record(initial, {
      source: "cli",
      trigger: "restart",
      summary: "Unchanged restart",
    });
    store.record(changed, {
      source: "config-file",
      trigger: "restart",
      configFile: CONFIG_FILE,
      summary: "bm2.config.json changed",
    });

    const history = store.listForConfig(changed);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      source: "config-file",
      trigger: "restart",
      configFile: CONFIG_FILE,
      summary: "bm2.config.json changed",
    });
    expect(history[0]!.changes.map(({ field }) => field).sort()).toEqual([
      "args",
      "restartDelay",
    ]);
    expect(history[1]).toMatchObject({ source: "cli", trigger: "start" });
  });
});

describe("loadEcosystemConfigFile", () => {
  test("invalidates executable config modules when their contents change", async () => {
    await writeFile(
      TYPESCRIPT_CONFIG_FILE,
      `export default { apps: [{ name: "service", script: "./service.ts", restartDelay: 1000 }] };\n`
    );
    const initial = await loadEcosystemConfigFile(TYPESCRIPT_CONFIG_FILE);

    await writeFile(
      TYPESCRIPT_CONFIG_FILE,
      `export default { apps: [{ name: "service", script: "./service.ts", restartDelay: 2000 }] };\n`
    );
    const changed = await loadEcosystemConfigFile(TYPESCRIPT_CONFIG_FILE);

    expect(initial.apps[0]!.restartDelay).toBe(1_000);
    expect(changed.apps[0]!.restartDelay).toBe(2_000);
    expect(changed.configFile).toBe(TYPESCRIPT_CONFIG_FILE);
  });
});

describe("config-file managed processes", () => {
  test("pick up changed bm2.config.json options on a normal restart", async () => {
    await writeFile(
      CONFIG_FILE,
      JSON.stringify({
        apps: [
          {
            name: "ai-prediction",
            script: "./service.ts",
            interpreter: "/home/capaj/.local/bin/uv",
            interpreterArgs: ["run", "python"],
            restartDelay: 10_000,
            args: ["--port", "5000", "--allow-incompatible-models"],
          },
        ],
      })
    );

    const manager = new ProcessManager({ historyStore: store });
    managers.push(manager);
    await manager.startEcosystem(await loadEcosystemConfigFile(CONFIG_FILE));

    await writeFile(
      CONFIG_FILE,
      JSON.stringify({
        apps: [
          {
            name: "ai-prediction",
            script: "./service.ts",
            interpreter: "/home/capaj/.local/bin/uv",
            interpreterArgs: ["run", "python"],
            restartDelay: 20_000,
            args: ["--port", "5000"],
          },
        ],
      })
    );

    const restarted = await manager.restartDetailed("ai-prediction");

    expect(restarted.configReloads).toEqual([
      {
        processName: "ai-prediction",
        configFile: CONFIG_FILE,
        changedFields: ["args", "restartDelay"],
      },
    ]);
    expect(formatConfigReloadNotice(restarted.configReloads[0]!)).toBe(
      "[bm2] bm2.config.json changed; loaded new configuration for " +
        "ai-prediction (args, restartDelay)"
    );

    const unchangedRestart = await manager.restartDetailed("ai-prediction");
    expect(unchangedRestart.configReloads).toEqual([]);

    const state = manager.describe("ai-prediction")[0]!;
    expect(state.bm2_env.args).toEqual(["--port", "5000"]);
    expect(state.bm2_env.restartDelay).toBe(20_000);
    expect(state.bm2_env.interpreter).toBe("/home/capaj/.local/bin/uv");
    expect(state.bm2_env.configSource).toMatchObject({
      type: "config-file",
      path: CONFIG_FILE,
      appIndex: 0,
    });

    const history = manager.getConfigHistory("ai-prediction");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      source: "config-file",
      trigger: "restart",
      summary: "bm2.config.json changed",
    });
    expect(history[0]!.changes.map(({ field }) => field).sort()).toEqual([
      "args",
      "restartDelay",
    ]);
  });

  test("reconciles an increased instance count from the config file", async () => {
    await writeFile(
      CONFIG_FILE,
      JSON.stringify({
        apps: [{ name: "worker", script: "./service.ts", instances: 1 }],
      })
    );

    const manager = new ProcessManager({ historyStore: store });
    managers.push(manager);
    await manager.startEcosystem(await loadEcosystemConfigFile(CONFIG_FILE));

    await writeFile(
      CONFIG_FILE,
      JSON.stringify({
        apps: [{ name: "worker", script: "./service.ts", instances: 2 }],
      })
    );
    const restarted = await manager.restart("worker");

    const workers = manager.describe("worker");
    expect(restarted).toHaveLength(2);
    expect(workers.map(({ name }) => name)).toEqual(["worker-0", "worker-1"]);
    expect(workers.every(({ bm2_env }) => bm2_env.instances === 2)).toBe(true);
  });

  test("removes excess instances when the config file count decreases", async () => {
    await writeFile(
      CONFIG_FILE,
      JSON.stringify({
        apps: [{ name: "worker", script: "./service.ts", instances: 2 }],
      })
    );

    const manager = new ProcessManager({ historyStore: store });
    managers.push(manager);
    await manager.startEcosystem(await loadEcosystemConfigFile(CONFIG_FILE));

    await writeFile(
      CONFIG_FILE,
      JSON.stringify({
        apps: [{ name: "worker", script: "./service.ts", instances: 1 }],
      })
    );
    await manager.restart("worker");

    const workers = manager.describe("worker");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.name).toBe("worker");
    expect(workers[0]!.bm2_env.instances).toBe(1);
  });
});
