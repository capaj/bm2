import pidusage from "pidusage";
import { readdir } from "node:fs/promises";
import { MONITOR_INTERVAL } from "./constants";

export interface ProcessUsage {
  cpu: number;
  memory: number;
}

export interface ProcessMonitoringTarget {
  getMonitoringPid(): number | null;
  applyMonitoringStats(
    pid: number,
    usage: ProcessUsage,
    handles?: number
  ): void | Promise<void>;
}

type PidUsageBatch = (
  pids: number[]
) => Promise<Record<string, ProcessUsage>>;

export interface BatchProcessMonitorOptions {
  interval?: number;
  handleSampleInterval?: number;
  pidusage?: PidUsageBatch;
  readHandles?: (pid: number) => Promise<number>;
}

export class BatchProcessMonitor {
  private active = false;
  private running = false;
  private sampleCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly interval: number;
  private readonly handleSampleInterval: number;
  private readonly getTargets: () => ProcessMonitoringTarget[];
  private readonly collectPidUsage: PidUsageBatch;
  private readonly readHandles: (pid: number) => Promise<number>;

  constructor(
    getTargets: () => ProcessMonitoringTarget[],
    options: BatchProcessMonitorOptions = {}
  ) {
    this.getTargets = getTargets;
    this.interval = options.interval ?? MONITOR_INTERVAL;
    this.handleSampleInterval = Math.max(
      1,
      options.handleSampleInterval ?? 5
    );
    this.collectPidUsage =
      options.pidusage ??
      ((pids) => pidusage(pids) as Promise<Record<string, ProcessUsage>>);
    this.readHandles =
      options.readHandles ??
      (async (pid) => (await readdir(`/proc/${pid}/fd`)).length);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async collectOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const targets = this.getTargets()
        .map((target) => ({ target, pid: target.getMonitoringPid() }))
        .filter(
          (entry): entry is { target: ProcessMonitoringTarget; pid: number } =>
            entry.pid !== null
        );
      if (targets.length === 0) return;

      const pids = [...new Set(targets.map(({ pid }) => pid))];
      const usageByPid = await this.collectPidUsage(pids);
      const collectHandles =
        process.platform === "linux" &&
        this.sampleCount % this.handleSampleInterval === 0;
      this.sampleCount++;

      const handlesByPid = new Map<number, number>();
      if (collectHandles) {
        await Promise.all(
          pids.map(async (pid) => {
            try {
              handlesByPid.set(pid, await this.readHandles(pid));
            } catch {
              // The process may have exited between the usage and fd reads.
            }
          })
        );
      }

      await Promise.all(
        targets.map(async ({ target, pid }) => {
          const usage = usageByPid[String(pid)];
          if (!usage) return;
          await target.applyMonitoringStats(pid, usage, handlesByPid.get(pid));
        })
      );
    } catch {
      // A process can disappear at any point during sampling. The next batch
      // will retry the remaining live processes.
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.collectOnce();
      if (this.active) this.schedule();
    }, this.interval);
    (this.timer as any).unref?.();
  }
}
