import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { ProcessContainer } from "../src/process-container";
import { ProcessManager } from "../src/process-manager";
import type { ProcessDescription } from "../src/types";
import { DUMP_FILE } from "../src/utils";
import { ConfigHistoryStore } from "../src/config-history-store";

const originalBunFile = Bun.file;
const originalBunWrite = Bun.write;
const originalContainerStart = ProcessContainer.prototype.start;

let dumpContents: string | undefined;
const managers: ProcessManager[] = [];
const historyStores: ConfigHistoryStore[] = [];

beforeEach(() => {
  dumpContents = undefined;

  Bun.write = (async (destination: string | URL, input: string) => {
    if (String(destination) === DUMP_FILE) {
      dumpContents = input;
      return Buffer.byteLength(input);
    }
    return originalBunWrite(destination, input);
  }) as typeof Bun.write;

  Bun.file = ((path: string | URL, options?: BlobPropertyBag) => {
    if (String(path) === DUMP_FILE) {
      return {
        exists: async () => dumpContents !== undefined,
        json: async () => JSON.parse(dumpContents!),
      } as Bun.BunFile;
    }
    return originalBunFile(path, options);
  }) as typeof Bun.file;

  ProcessContainer.prototype.start = async function () {
    this.startedAt = Date.now();
    this.status = "online";
  };
});

afterEach(() => {
  Bun.file = originalBunFile;
  Bun.write = originalBunWrite;
  ProcessContainer.prototype.start = originalContainerStart;

  for (const manager of managers) {
    (manager as any).processMonitor.stop();
  }
  managers.length = 0;
  for (const store of historyStores) store.close();
  historyStores.length = 0;
});

describe("process persistence", () => {
  test("round-trips the complete normalized process config", async () => {
    const config: ProcessDescription = {
      id: 17,
      name: "complete-config",
      script: join(import.meta.dir, "../src/index.ts"),
      args: ["--flag", "value"],
      cwd: join(import.meta.dir, ".."),
      env: { NODE_ENV: "test", FEATURE_FLAG: "enabled" },
      instances: 3,
      execMode: "cluster",
      autorestart: true,
      maxRestarts: 27,
      minUptime: 12_345,
      maxMemoryRestart: 512 * 1024 * 1024,
      watch: true,
      watchPaths: [join(import.meta.dir, "../src")],
      ignoreWatch: ["node_modules", "generated"],
      cronRestart: "15 4 * * *",
      interpreter: "/home/test/.local/bin/uv",
      interpreterArgs: ["run", "python"],
      mergeLogs: true,
      logDateFormat: "YYYY-MM-DD HH:mm:ss",
      errorFile: "/tmp/bm2-complete-error.log",
      outFile: "/tmp/bm2-complete-out.log",
      pidFile: "/tmp/bm2-complete.pid",
      killTimeout: 8_765,
      restartDelay: 4_321,
      listenTimeout: 9_876,
      shutdownWithMessage: true,
      treekill: false,
      port: 41_000,
      clusterMode: true,
      reusePort: true,
      healthCheckUrl: "http://127.0.0.1:41000/health",
      healthCheckInterval: 11_111,
      healthCheckTimeout: 2_222,
      healthCheckMaxFails: 7,
      logMaxSize: 64 * 1024 * 1024,
      logRetain: 13,
      logCompress: true,
      gracefulListenTimeout: 7_654,
      waitReady: true,
      deployConfig: {
        user: "deploy",
        host: ["app-1.example.com", "app-2.example.com"],
        ref: "origin/main",
        repo: "git@example.com:org/app.git",
        path: "/srv/app",
        preDeploy: "bun test",
        postDeploy: "bun install",
        preSetup: "mkdir -p /srv/app",
        postSetup: "echo ready",
        ssh_options: ["StrictHostKeyChecking=yes"],
        env: { DEPLOY_ENV: "production" },
      },
      sourceMapSupport: true,
      nodeArgs: ["--max-old-space-size=2048"],
      namespace: "prediction",
      version: "1.2.3",
      versioningConfig: {
        currentVersion: "1.2.3",
        previousVersions: ["1.2.2", "1.2.1"],
        maxVersions: 5,
      },
    };

    const sourceHistory = new ConfigHistoryStore(":memory:");
    historyStores.push(sourceHistory);
    const source = new ProcessManager({ historyStore: sourceHistory });
    managers.push(source);
    (source as any).processes.set(config.id, {
      config,
      restartCount: 9,
    });
    await source.save();

    const restoredHistory = new ConfigHistoryStore(":memory:");
    historyStores.push(restoredHistory);
    const restored = new ProcessManager({ historyStore: restoredHistory });
    managers.push(restored);
    await restored.resurrect();

    const restoredContainers = Array.from(
      (restored as any).processes.values()
    ) as ProcessContainer[];
    expect(restoredContainers).toHaveLength(1);
    expect(restoredContainers[0]!.config).toEqual(config);
    expect(restoredContainers[0]!.restartCount).toBe(9);
    expect((restored as any).nextId).toBe(config.id + 1);
  });
});
