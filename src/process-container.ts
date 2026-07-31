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
import type { Subprocess } from "bun";
import type {
  ProcessDescription,
  DashboardProcessState,
  ProcessState,
  ProcessStatus,
  LogRotateOptions,
  ConfigHistoryTrigger,
} from "./types";
import { LogManager } from "./log-manager";
import { ClusterManager } from "./cluster-manager";
import { HealthChecker } from "./health-checker";
import { CronManager } from "./cron-manager";
import { treeKill } from "./utils";
import { join } from "path";
import {
  PID_DIR,
  DEFAULT_LOG_MAX_SIZE,
  DEFAULT_LOG_RETAIN,
} from "./constants";
import type { ProcessUsage } from "./process-monitor";

const MAX_UNTERMINATED_LOG_CHARS = 8 * 1024;

export type BeforeProcessStart = (
  container: ProcessContainer,
  trigger: ConfigHistoryTrigger
) => Promise<boolean | void>;

export class ProcessContainer {
  public id: number;
  public name: string;
  public config: ProcessDescription;
  public status: ProcessStatus = "stopped";
  public process: Subprocess | null = null;
  public pid: number | undefined;
  public restartCount: number = 0;
  public unstableRestarts: number = 0;
  public createdAt: number;
  public startedAt: number = 0;
  public memory: number = 0;
  public cpu: number = 0;
  public handles: number = 0;
  public eventLoopLatency: number = 0;
  public axmMonitor: Record<string, any> = {};

  private logManager: LogManager;
  private clusterManager: ClusterManager;
  private healthChecker: HealthChecker;
  private cronManager: CronManager;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof import("fs").watch> | null = null;
  private logRotateInterval: ReturnType<typeof setInterval> | null = null;
  private isRestarting: boolean = false;
  private beforeStart?: BeforeProcessStart;

  constructor(
    id: number,
    config: ProcessDescription,
    logManager: LogManager,
    clusterManager: ClusterManager,
    healthChecker: HealthChecker,
    cronManager: CronManager,
    beforeStart?: BeforeProcessStart
  ) {
    this.id = id;
    this.name = config.name;
    this.config = config;
    this.logManager = logManager;
    this.clusterManager = clusterManager;
    this.healthChecker = healthChecker;
    this.cronManager = cronManager;
    this.beforeStart = beforeStart;
    this.createdAt = Date.now();
  }

  async start(trigger: ConfigHistoryTrigger = "automatic-restart"): Promise<void> {
    let shouldStart: boolean | void;
    try {
      shouldStart = await this.beforeStart?.(this, trigger);
    } catch (error) {
      this.status = "errored";
      throw error;
    }
    if (shouldStart === false) return;
    if (this.status === "online") return;

    this.status = "launching";
    const logPaths = this.logManager.getLogPaths(
      this.name,
      this.id,
      this.config.outFile,
      this.config.errorFile
    );

    try {
      // Ensure log files exist
      for (const f of [logPaths.outFile, logPaths.errFile]) {
        const file = Bun.file(f);
        if (!(await file.exists())) await Bun.write(f, "");
      }

      if (this.config.execMode === "cluster" && this.config.instances > 1) {
        await this.startCluster(logPaths);
      } else {
        await this.startFork(logPaths);
      }

      this.startedAt = Date.now();
      this.status = "online";

      // Write PID file
      if (this.pid) {
        await Bun.write(
          join(PID_DIR, `${this.name}-${this.id}.pid`),
          String(this.pid)
        );
      }

      // Start log rotation
      this.startLogRotation(logPaths);

      // Setup watch mode
      if (this.config.watch) {
        this.setupWatch();
      }

      // Setup health checks
      if (this.config.healthCheckUrl) {
        this.healthChecker.startCheck(
          this.id,
          {
            url: this.config.healthCheckUrl,
            interval: this.config.healthCheckInterval || 30000,
            timeout: this.config.healthCheckTimeout || 5000,
            maxFails: this.config.healthCheckMaxFails || 3,
          },
          (_id, reason) => {
            console.log(`[bm2] Health check failed for ${this.name}: ${reason}`);
            this.restart("health-check");
          }
        );
      }

      // Setup cron restart
      if (this.config.cronRestart) {
        this.cronManager.schedule(this.id, this.config.cronRestart, () => {
          console.log(`[bm2] Cron restart triggered for ${this.name}`);
          this.restart("cron");
        });
      }
    } catch (err: any) {
      this.status = "errored";

      this.logManager.appendJSONLog(
        logPaths.errFile,
        `[bm2] Failed to start: ${err.message}`
      );

      throw err;
    }
  }

  private async startFork(logPaths: { outFile: string; errFile: string }) {
    const cmd = this.clusterManager.buildWorkerCommand(this.config);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.config.env,
      BM2_ID: String(this.id),
      BM2_NAME: this.name,
      BM2_EXEC_MODE: "fork",
    };

    this.process = Bun.spawn(cmd, {
      cwd: this.config.cwd || process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    this.pid = this.process.pid;
    this.pipeOutput(logPaths);

    this.process.exited.then((code) => {
      if (!this.isRestarting) {
        this.handleExit(code);
      }
    });
  }

  private async startCluster(logPaths: { outFile: string; errFile: string }) {
    const proc = this.clusterManager.spawnWorker(
      this.config,
      0,
      this.config.instances,
      { stdout: "pipe", stderr: "pipe" }
    );

    this.process = proc;
    this.pid = proc.pid;

    if (proc.stdout && typeof proc.stdout !== "number") {
      this.pipeStream(proc.stdout, logPaths.outFile);
    }
    if (proc.stderr && typeof proc.stderr !== "number") {
      this.pipeStream(proc.stderr, logPaths.errFile);
    }

    proc.exited.then((code) => {
      if (!this.isRestarting) {
        this.handleExit(code);
      }
    });
  }

  private pipeOutput(logPaths: { outFile: string; errFile: string }) {
    if (!this.process) return;
    if (this.process.stdout && typeof this.process.stdout !== "number") {
      this.pipeStream(this.process.stdout, logPaths.outFile);
    }
    if (this.process.stderr && typeof this.process.stderr !== "number") {
      this.pipeStream(this.process.stderr, logPaths.errFile);
    }
  }

  private async pipeStream(stream: ReadableStream<Uint8Array>, filePath: string) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let remainder = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          remainder += decoder.decode();
          if (remainder.length > 0) {
            this.logManager.appendJSONLog(filePath, remainder);
          }
          break;
        }

        // TextDecoder preserves UTF-8 sequences split across pipe reads, while
        // remainder preserves logical lines split across those same reads.
        const text = remainder + decoder.decode(value, { stream: true });
        const lines = text.split(/\r?\n/);
        remainder = lines.pop() ?? "";

        // A process that never emits a newline must not grow daemon memory
        // indefinitely. Preserve all output as bounded continuation records.
        while (remainder.length >= MAX_UNTERMINATED_LOG_CHARS) {
          let end = MAX_UNTERMINATED_LOG_CHARS;
          const lastCodeUnit = remainder.charCodeAt(end - 1);
          const nextCodeUnit = remainder.charCodeAt(end);
          if (
            lastCodeUnit >= 0xd800 &&
            lastCodeUnit <= 0xdbff &&
            nextCodeUnit >= 0xdc00 &&
            nextCodeUnit <= 0xdfff
          ) {
            end--;
          }
          lines.push(remainder.slice(0, end));
          remainder = remainder.slice(end);
        }

        this.logManager.appendJSONLogs(filePath, lines);
      }
    } catch {
      if (remainder.length > 0) {
        this.logManager.appendJSONLog(filePath, remainder);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private startLogRotation(logPaths: { outFile: string; errFile: string }) {
    const rotateOpts: LogRotateOptions = {
      maxSize: this.config.logMaxSize || DEFAULT_LOG_MAX_SIZE,
      retain: this.config.logRetain || DEFAULT_LOG_RETAIN,
      compress: this.config.logCompress || false,
    };

    this.logRotateInterval = setInterval(() => {
      this.logManager.checkRotation(
        this.name,
        this.id,
        rotateOpts,
        this.config.outFile,
        this.config.errorFile
      );
    }, 60000);
  }

  private setupWatch() {
    const { watch } = require("fs");
    const paths = this.config.watchPaths || [this.config.cwd || process.cwd()];
    const ignorePatterns = this.config.ignoreWatch || ["node_modules", ".git", ".bm2"];

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    for (const watchPath of paths) {
      try {
        this.watcher = watch(
          watchPath,
          { recursive: true },
          (_event: string, filename: string | null) => {
            if (!filename) return;
            if (ignorePatterns.some((p) => filename.includes(p))) return;

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              console.log(`[bm2] ${filename} changed, restarting ${this.name}...`);
              this.restart("watch");
            }, 1000);
          }
        );
      } catch {}
    }
  }

  private handleExit(code: number | null) {
    const wasOnline = this.status === "online";
    this.status = code === 0 ? "stopped" : "errored";
    this.pid = undefined;
    this.process = null;

    this.cleanupTimers();

    const uptime = Date.now() - this.startedAt;
    const wasStable = uptime >= this.config.minUptime;

    if (wasStable) {
      this.unstableRestarts = 0;
    }

    if (!wasOnline || !this.config.autorestart) return;

    if (this.unstableRestarts < this.config.maxRestarts) {
      if (!wasStable) {
        this.unstableRestarts++;
      }

      this.status = "waiting-restart";
      const delay = this.config.restartDelay || 0;

      this.restartTimer = setTimeout(() => {
        this.restartCount++;
        console.log(
          `[bm2] Restarting ${this.name} (restart ${this.restartCount}, ` +
          `unstable ${this.unstableRestarts}/${this.config.maxRestarts})`
        );
        this.start("automatic-restart").catch((err) => {
          console.error(`[bm2] Failed to restart ${this.name}:`, err);
        });
      }, delay);
    } else {
      console.log(
        `[bm2] ${this.name} reached max consecutive unstable restarts ` +
        `(${this.config.maxRestarts}), not restarting`
      );
      this.status = "errored";
    }
  }

  private cleanupTimers() {
    if (this.logRotateInterval) {
      clearInterval(this.logRotateInterval);
      this.logRotateInterval = null;
    }
    this.healthChecker.stopCheck(this.id);
    this.cronManager.cancel(this.id);
  }

  async stop(force: boolean = false): Promise<void> {
    if (this.status !== "online" && this.status !== "launching" && this.status !== "waiting-restart") {
      return;
    }

    this.isRestarting = false;
    this.status = "stopping";
    this.config.autorestart = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.cleanupTimers();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.process && this.pid) {
      if (this.config.treekill !== false) {
        await treeKill(this.pid, "SIGTERM");
      } else {
        this.process.kill("SIGTERM" as any);
      }

      if (!force) {
        const timeout = this.config.killTimeout || 5000;
        const exited = await Promise.race([
          this?.process?.exited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), timeout)),
        ]);

        if (!exited && this.process) {
          if (this.config.treekill !== false && this.pid) {
            await treeKill(this.pid, "SIGKILL");
          } else {
            this.process.kill("SIGKILL" as any);
          }
          await this?.process?.exited;
        }
      } else {
        if (this.config.treekill !== false && this.pid) {
          await treeKill(this.pid, "SIGKILL");
        } else {
          this.process.kill("SIGKILL" as any);
        }
        await this?.process?.exited;
      }
    }

    // Clean up cluster workers
    this.clusterManager.removeAllWorkers(this.id);

    this.status = "stopped";
    this.pid = undefined;
    this.process = null;
    this.memory = 0;
    this.cpu = 0;
  }

  async restart(trigger: ConfigHistoryTrigger = "restart"): Promise<void> {
    this.isRestarting = true;
    const wasAutoRestart = this.config.autorestart;
    await this.stop();
    this.config.autorestart = wasAutoRestart;
    this.isRestarting = false;
    await this.start(trigger);
  }

  async reload(trigger: ConfigHistoryTrigger = "reload"): Promise<void> {
    const oldPid = this.pid;
    const oldProcess = this.process;

    this.isRestarting = true;
    this.process = null;
    this.pid = undefined;

    await this.start(trigger);

    // Wait for new process to be stable
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Kill old process
    if (oldProcess && oldPid) {
      try {
        if (this.config.treekill !== false) {
          await treeKill(oldPid, "SIGTERM");
        } else {
          oldProcess.kill("SIGTERM" as any);
        }
      } catch {}
    }

    this.isRestarting = false;
  }

  async sendSignal(signal: string): Promise<void> {
    if (this.pid) {
      process.kill(this.pid, signal as any);
    }
  }

  updateConfig(config: ProcessDescription): void {
    this.config = config;
    this.name = config.name;
  }

  getState(): ProcessState {
    return {
      id: this.id,
      name: this.name,
      namespace: this.config.namespace,
      status: this.status,
      pid: this.pid,
      pm_id: this.id,
      monit: {
        memory: this.memory,
        cpu: this.cpu,
        handles: this.handles,
        eventLoopLatency: this.eventLoopLatency,
      },
      bm2_env: {
        ...this.config,
        status: this.status,
        pm_uptime: this.startedAt,
        restart_time: this.restartCount,
        unstable_restarts: this.unstableRestarts,
        created_at: this.createdAt,
        pm_id: this.id,
        axm_monitor: this.axmMonitor,
      },
    };
  }

  getDashboardState(): DashboardProcessState {
    return {
      pm_id: this.id,
      name: this.name,
      status: this.status,
      pid: this.pid,
      cpu: this.cpu,
      memory: this.memory,
      restarts: this.restartCount,
      startedAt: this.startedAt,
    };
  }

  getMonitoringPid(): number | null {
    return this.status === "online" && this.pid ? this.pid : null;
  }

  async applyMonitoringStats(
    pid: number,
    usage: ProcessUsage,
    handles?: number
  ): Promise<void> {
    // A restart can complete while a batch is being sampled. Never apply
    // metrics collected for the previous child process.
    if (this.status !== "online" || this.pid !== pid) return;

    this.memory = usage.memory;
    this.cpu = usage.cpu;
    if (handles !== undefined) this.handles = handles;

    if (
      this.config.maxMemoryRestart &&
      this.memory > this.config.maxMemoryRestart
    ) {
      console.log(
        `[bm2] ${this.name} exceeded memory limit (${this.memory} > ${this.config.maxMemoryRestart}), restarting...`
      );
      await this.restart("memory-limit");
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      config: this.config,
      restartCount: this.restartCount,
    };
  }
}
