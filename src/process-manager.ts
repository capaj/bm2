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
 import type {
   ProcessDescription,
   DashboardProcessState,
   ProcessState,
   StartOptions,
   EcosystemConfig,
   MetricSnapshot,
   LogEntry,
   LogItem,
   ConfigHistoryEntry,
   ConfigReloadNotice,
   ConfigHistorySource,
   ConfigHistoryTrigger,
   RestartResult,
 } from "./types";
 import { ProcessContainer } from "./process-container";
 import { LogManager } from "./log-manager";
 import { ClusterManager } from "./cluster-manager";
 import { HealthChecker } from "./health-checker";
 import { CronManager } from "./cron-manager";
 import { Monitor } from "./monitor";
 import { GracefulReload } from "./graceful-reload";
 import { BatchProcessMonitor } from "./process-monitor";
 import { parseMemory, DUMP_FILE } from "./utils";
 import {
   ConfigHistoryStore,
   type ConfigHistoryContext,
 } from "./config-history-store";
 import { loadEcosystemConfigFile } from "./ecosystem-loader";
 import {
   DEFAULT_KILL_TIMEOUT,
   DEFAULT_MAX_RESTARTS,
   DEFAULT_MIN_UPTIME,
   DEFAULT_RESTART_DELAY,
   DEFAULT_LOG_MAX_SIZE,
   DEFAULT_LOG_RETAIN,
 } from "./constants";
import path from "path";
 import type { ReadableStreamController } from "bun";

 interface SavedProcess {
   config: ProcessDescription;
   restartCount?: number;
 }

 interface ProcessManagerOptions {
   historyStore?: ConfigHistoryStore;
   configLoader?: typeof loadEcosystemConfigFile;
 }

 interface StartContext {
   source: ConfigHistorySource;
   trigger: ConfigHistoryTrigger;
   configFile?: string;
   summary: string;
 }
 
 export class ProcessManager {
   private processes: Map<number, ProcessContainer> = new Map();
   private nextId: number = 0;
   public logManager: LogManager;
   public clusterManager: ClusterManager;
   public healthChecker: HealthChecker;
   public cronManager: CronManager;
   public monitor: Monitor;
   public gracefulReload: GracefulReload;
   private processMonitor: BatchProcessMonitor;
   private historyStore: ConfigHistoryStore;
   private configLoader: typeof loadEcosystemConfigFile;
 
   constructor(options: ProcessManagerOptions = {}) {
     this.logManager = new LogManager();
     this.clusterManager = new ClusterManager();
     this.healthChecker = new HealthChecker();
     this.cronManager = new CronManager();
     this.monitor = new Monitor();
     this.gracefulReload = new GracefulReload();
     this.historyStore = options.historyStore ?? new ConfigHistoryStore();
     this.configLoader = options.configLoader ?? loadEcosystemConfigFile;
     this.processMonitor = new BatchProcessMonitor(() =>
       Array.from(this.processes.values())
     );
   }
 
  async start(
    options: StartOptions,
    context: StartContext = {
      source: options.configSource?.type === "config-file" ? "config-file" : "cli",
      trigger: "start",
      configFile: options.configSource?.path,
      summary:
        options.configSource?.type === "config-file"
          ? "Registered from ecosystem config"
          : "Started from CLI/API options",
    }
  ): Promise<ProcessState[]> {
        
    const resolvedInstances = this.clusterManager.resolveInstances(options.instances);
    const isCluster = options.execMode === "cluster" || resolvedInstances > 1;
    const states: ProcessState[] = [];
    
    options.script = path.isAbsolute(options.script) 
      ? options.script
      : path.join(options.cwd!, options.script);
    
    
    if (!(await Bun.file(options.script).exists())) {
      throw new Error(`Script not found: ${options.script}`);
    } 
 
    if (isCluster) {
      // In cluster mode, each instance is a separate container
      for (let i = 0; i < resolvedInstances; i++) {
          
        const id = this.nextId++;
        const baseName = options.name || options.script.split("/").pop()?.replace(/\.\w+$/, "") || `app-${id}`;
        const name = resolvedInstances > 1 ? `${baseName}-${i}` : baseName;

        const config = this.buildConfig(id, name, options, resolvedInstances, i);
        
        const container = this.createContainer(id, config);

        this.processes.set(id, container);
        await container.start(context.trigger);
        this.recordConfig(container.config, context);
        this.processMonitor.start();
        states.push(container.getState());
      }
      
    } else {
      const id = this.nextId++;
      const name =
          options.name ||
          options.script.split("/").pop()?.replace(/\.\w+$/, "") ||
          `app-${id}`;
  
      const config = this.buildConfig(id, name, options, 1, 0);
      const container = this.createContainer(id, config);
  
      this.processes.set(id, container);
      await container.start(context.trigger);
      this.recordConfig(container.config, context);
      this.processMonitor.start();
      states.push(container.getState());
    }

    return states;
  }
 
   private buildConfig(
     id: number,
     name: string,
     options: StartOptions,
     instances: number,
     workerIndex: number
   ): ProcessDescription {
     return {
       id,
       name,
       script: options.script,
       args: options.args || [],
       cwd: options.cwd || process.cwd(),
       env: {
         ...options.env,
         ...(instances > 1
           ? {
               NODE_APP_INSTANCE: String(workerIndex),
               BM2_INSTANCE_ID: String(workerIndex),
             }
           : {}),
       },
       instances,
       execMode: instances > 1 ? "cluster" : (options.execMode || "fork"),
       autorestart: options.autorestart !== false,
       maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
       minUptime: options.minUptime ?? DEFAULT_MIN_UPTIME,
       maxMemoryRestart: options.maxMemoryRestart
         ? parseMemory(options.maxMemoryRestart)
         : undefined,
       watch: Array.isArray(options.watch) ? true : (options.watch ?? false),
       watchPaths: Array.isArray(options.watch) ? options.watch : undefined,
       ignoreWatch: options.ignoreWatch || ["node_modules", ".git", ".bm2"],
       cronRestart: options.cron,
       interpreter: options.interpreter,
       interpreterArgs: options.interpreterArgs,
       mergeLogs: options.mergeLogs ?? false,
       logDateFormat: options.logDateFormat,
       errorFile: options.errorFile,
       outFile: options.outFile,
       killTimeout: options.killTimeout ?? DEFAULT_KILL_TIMEOUT,
       restartDelay: options.restartDelay ?? DEFAULT_RESTART_DELAY,
       port: options.port,
       healthCheckUrl: options.healthCheckUrl,
       healthCheckInterval: options.healthCheckInterval,
       healthCheckTimeout: options.healthCheckTimeout,
       healthCheckMaxFails: options.healthCheckMaxFails,
       logMaxSize: options.logMaxSize ? parseMemory(options.logMaxSize) : DEFAULT_LOG_MAX_SIZE,
       logRetain: options.logRetain ?? DEFAULT_LOG_RETAIN,
       logCompress: options.logCompress,
       waitReady: options.waitReady,
       listenTimeout: options.listenTimeout,
       namespace: options.namespace,
       nodeArgs: options.nodeArgs,
       sourceMapSupport: options.sourceMapSupport,
       treekill: true,
       configSource: options.configSource
         ? { ...options.configSource, workerIndex }
         : { type: "cli", workerIndex },
     };
   }

   private createContainer(
     id: number,
     config: ProcessDescription
   ): ProcessContainer {
     return new ProcessContainer(
       id,
       config,
       this.logManager,
       this.clusterManager,
       this.healthChecker,
       this.cronManager,
       (container, trigger) => this.refreshConfigBeforeStart(container, trigger)
     );
   }

   private recordConfig(
     config: ProcessDescription,
     context: ConfigHistoryContext
   ): void {
     this.historyStore.record(config, context);
   }

   private async refreshConfigBeforeStart(
     container: ProcessContainer,
     trigger: ConfigHistoryTrigger,
     allowInstanceExpansion = trigger !== "start" && trigger !== "resurrect"
   ): Promise<boolean> {
     const source = container.config.configSource;
     if (source?.type !== "config-file" || !source.path) return true;

     const ecosystem = await this.configLoader(source.path);
     let appIndex = source.appIndex ?? -1;
     let app = ecosystem.apps[appIndex];
     if (source.appName && app?.name !== source.appName) {
       const matchingIndex = ecosystem.apps.findIndex(
         ({ name }) => name === source.appName
       );
       if (matchingIndex >= 0) {
         appIndex = matchingIndex;
         app = ecosystem.apps[appIndex];
       }
     }
     if (!app) {
       throw new Error(
         `App ${source.appName || `at index ${source.appIndex}`} no longer exists in ${source.path}`
       );
     }

     const instances = this.clusterManager.resolveInstances(app.instances);
     const workerIndex = source.workerIndex ?? 0;
     const options: StartOptions = {
       ...app,
       configSource: {
         type: "config-file",
         path: source.path,
         appIndex,
         appName: source.appName ?? app.name,
         workerIndex,
       },
     };
     const baseName =
       options.name ||
       options.script.split("/").pop()?.replace(/\.\w+$/, "") ||
       `app-${container.id}`;

     const group = Array.from(this.processes.values()).filter((candidate) => {
       const candidateSource = candidate.config.configSource;
       return (
         candidateSource?.type === "config-file" &&
         candidateSource.path === source.path &&
         (candidateSource.appIndex === source.appIndex ||
           (source.appName !== undefined &&
             candidateSource.appName === source.appName))
       );
     });

     for (const candidate of group) {
       const candidateIndex = candidate.config.configSource?.workerIndex ?? 0;
       if (candidateIndex < instances) continue;
       if (candidate !== container) await candidate.stop(true);
       this.processes.delete(candidate.id);
     }
     if (workerIndex >= instances) return false;

     if (allowInstanceExpansion) {
       const existingIndexes = new Set(
         Array.from(this.processes.values())
           .filter((candidate) => {
             const candidateSource = candidate.config.configSource;
             return (
               candidateSource?.type === "config-file" &&
               candidateSource.path === source.path &&
               (candidateSource.appIndex === source.appIndex ||
                 (source.appName !== undefined &&
                   candidateSource.appName === source.appName))
             );
           })
           .map(
             (candidate) => candidate.config.configSource?.workerIndex ?? 0
           )
       );
       const added: ProcessContainer[] = [];
       for (let index = 0; index < instances; index++) {
         if (existingIndexes.has(index)) continue;
         const id = this.nextId++;
         const name = instances > 1 ? `${baseName}-${index}` : baseName;
         const addedOptions: StartOptions = {
           ...options,
           configSource: { ...options.configSource!, workerIndex: index },
         };
         const addedContainer = this.createContainer(
           id,
           this.buildConfig(id, name, addedOptions, instances, index)
         );
         this.processes.set(id, addedContainer);
         added.push(addedContainer);
       }
       for (const addedContainer of added) {
         await addedContainer.start(trigger);
         this.recordConfig(addedContainer.config, {
           source: "config-file",
           trigger,
           configFile: source.path,
           summary: "bm2.config.json changed",
         });
       }
       if (added.length > 0) this.processMonitor.start();
     }

     const name = instances > 1 ? `${baseName}-${workerIndex}` : baseName;
     const refreshed = this.buildConfig(
       container.id,
       name,
       options,
       instances,
       workerIndex
     );

     const previous = JSON.stringify(container.config);
     container.updateConfig(refreshed);
     if (JSON.stringify(refreshed) !== previous) {
       this.recordConfig(refreshed, {
         source: "config-file",
         trigger,
         configFile: source.path,
         summary: "bm2.config.json changed",
       });
     }
     return true;
   }
 
   async stop(target: string | number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     const states: ProcessState[] = [];
     for (const c of containers) {
       await c.stop();
       states.push(c.getState());
     }
     this.stopProcessMonitorWhenIdle();
     return states;
   }
 
   async restart(target: string | number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     for (const c of containers) {
       if (!this.processes.has(c.id)) continue;
       await c.restart("restart");
     }
     const states = this.expandConfigGroups(containers).map((c) => c.getState());
     if (states.length > 0) this.processMonitor.start();
     return states;
   }

   async restartDetailed(target: string | number): Promise<RestartResult> {
     const containers = this.resolveTarget(target);
     const previousHistoryIds = this.latestConfigHistoryIds(containers);
     const states = await this.restart(target);
     const currentContainers = this.expandConfigGroups(containers);

     return {
       states,
       configReloads: this.configReloadNoticesSince(
         currentContainers,
         previousHistoryIds
       ),
     };
   }
 
   async reload(target: string | number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     for (const container of containers) {
       await this.refreshConfigBeforeStart(container, "reload");
     }
     // Use graceful reload for zero downtime
     await this.gracefulReload.reload(containers);
     if (containers.length > 0) this.processMonitor.start();
     return this.expandConfigGroups(containers)
       .map((container) => container.getState());
   }
 
   async del(target: string | number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     const states: ProcessState[] = [];
     for (const c of containers) {
       await c.stop(true);
       states.push(c.getState());
       this.processes.delete(c.id);
     }
     this.stopProcessMonitorWhenIdle();
     return states;
   }
 
   async stopAll(): Promise<ProcessState[]> {
     const states: ProcessState[] = [];
     for (const c of this.processes.values()) {
       await c.stop();
       states.push(c.getState());
     }
     this.processMonitor.stop();
     return states;
   }
 
   async restartAll(): Promise<ProcessState[]> {
     const states: ProcessState[] = [];
     for (const c of Array.from(this.processes.values())) {
       if (!this.processes.has(c.id)) continue;
       await c.restart("restart");
       if (this.processes.has(c.id)) states.push(c.getState());
     }
     if (states.length > 0) this.processMonitor.start();
     return states;
   }

   async restartAllDetailed(): Promise<RestartResult> {
     const containers = Array.from(this.processes.values());
     const previousHistoryIds = this.latestConfigHistoryIds(containers);
     const states = await this.restartAll();

     return {
       states,
       configReloads: this.configReloadNoticesSince(
         Array.from(this.processes.values()),
         previousHistoryIds
       ),
     };
   }
 
   async reloadAll(): Promise<ProcessState[]> {
     const containers = Array.from(this.processes.values());
     for (const container of containers) {
       await this.refreshConfigBeforeStart(container, "reload");
     }
     await this.gracefulReload.reload(containers);
     if (containers.length > 0) this.processMonitor.start();
     return this.expandConfigGroups(containers)
       .map((container) => container.getState());
   }
 
   async deleteAll(): Promise<ProcessState[]> {
     const states: ProcessState[] = [];
     for (const c of this.processes.values()) {
       await c.stop(true);
       await Bun.sleep(100)
       states.push(c.getState());
     }
     this.processes.clear();
     this.processMonitor.stop();
     this.nextId = 0;
     return states;
   }
 
   async scale(target: string | number, count: number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     if (containers.length === 0) return [];
   
     const first = containers[0]!;
     const baseName = first.name.replace(/-\d+$/, "");
     const currentCount = containers.length;
   
     if (count > currentCount) {
       // Scale up
       const toAdd = count - currentCount;
       const baseConfig = first.config;
       const states: ProcessState[] = [];
   
       for (let i = 0; i < toAdd; i++) {
         const result = await this.start({
           name: `${baseName}-${currentCount + i}`,
           script: baseConfig.script,
           args: baseConfig.args,
           cwd: baseConfig.cwd,
           env: baseConfig.env,
           execMode: baseConfig.execMode,
           autorestart: baseConfig.autorestart,
           maxRestarts: baseConfig.maxRestarts,
           watch: baseConfig.watch,
           port: baseConfig.port,
         });
         states.push(...result);
       }
   
       return [...containers.map((c) => c.getState()), ...states];
     } else if (count < currentCount) {
       // Scale down
       const toRemove = containers.slice(count);
       for (const c of toRemove) {
         await c.stop(true);
         this.processes.delete(c.id);
       }
       this.stopProcessMonitorWhenIdle();
       return containers.slice(0, count).map((c) => c.getState());
     }
   
     return containers.map((c) => c.getState());
   }
   
   list(): ProcessState[] {
     return Array.from(this.processes.values()).map((p) => p.getState());
   }

   listDashboard(): DashboardProcessState[] {
     return Array.from(this.processes.values()).map((p) => p.getDashboardState());
   }
 
   describe(target: string | number): ProcessState[] {
     return this.resolveTarget(target).map((p) => p.getState());
   }
 
   async getLogs(target: string | number, lines: number = 20) {
     
     const containers = this.resolveTarget(target);
     
    // just for readability
     let results: LogItem[] = [];
          
     results = (await Promise.all(containers.map((c) =>
       this.logManager.readLogs(
         c.name,
         c.id,
         lines,
         c.config.outFile,
         c.config.errorFile
       )
     ))).flat();
     
     
     let sortedResults = results
       .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))
     
     
     return sortedResults;
   }
   
   async streamLogs(target: string | number, streamController: ReadableStreamDefaultController, signal: AbortSignal) {
     
     const containers = this.resolveTarget(target);
     const lm = this.logManager;
     
     await Promise.all(containers.map(async (c) => (
      lm.tailLog(
        c.name,
        c.id,
        streamController,
        signal,
        c.config.outFile,
        c.config.errorFile
      )
     )))
     
   }

   async subscribeLogs(
     target: string | number,
     lines: number,
     onSnapshot: (logs: LogItem[]) => void,
     onLog: (log: LogItem) => void,
     signal: AbortSignal
   ): Promise<void> {
     const containers = this.resolveTarget(target);
     const streams = await Promise.all(
       containers.map(async (container) => ({
         prepared: await this.logManager.prepareLogStream(
           container.name,
           container.id,
           lines,
           container.config.outFile,
           container.config.errorFile
         ),
       }))
     );

     if (signal.aborted) return;

     const snapshot = streams
       .flatMap(({ prepared }) => prepared.logs)
       .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))
       .slice(-lines);
     onSnapshot(snapshot);

     if (signal.aborted) return;

     const stops = streams.map(({ prepared }) => prepared.start(onLog));
     const stop = () => {
       for (const stopStream of stops) stopStream();
     };

     if (signal.aborted) {
       stop();
       return;
     }
     signal.addEventListener("abort", stop, { once: true });
   }
 
   async flushLogs(target?: string | number) {
     const containers = target
       ? this.resolveTarget(target)
       : Array.from(this.processes.values());
     for (const c of containers) {
       await this.logManager.flush(c.name, c.id, c.config.outFile, c.config.errorFile);
     }
   }
 
   async save(): Promise<void> {
     const data: SavedProcess[] = Array.from(this.processes.values()).map((p) => ({
       config: p.config,
       restartCount: p.restartCount,
     }));
     await Bun.write(DUMP_FILE, JSON.stringify(data, null, 2));
   }
 
   async resurrect(): Promise<ProcessState[]> {
     try {
       const file = Bun.file(DUMP_FILE);
       if (!(await file.exists())) return [];
       const data = await file.json() as SavedProcess[];
 
       for (const item of data) {
         const config = item.config;
         const container = this.createContainer(config.id, config);
         container.restartCount = item.restartCount ?? 0;

         this.processes.set(config.id, container);
         this.nextId = Math.max(this.nextId, config.id + 1);
         await container.start("resurrect");
         this.recordConfig(container.config, {
           source: "saved-state",
           trigger: "resurrect",
           configFile: container.config.configSource?.path,
           summary: "Restored from BM2 saved state",
         });
       }

       const reconciledGroups = new Set<string>();
       for (const container of Array.from(this.processes.values())) {
         const source = container.config.configSource;
         if (source?.type !== "config-file" || !source.path) continue;
         const groupKey = `${source.path}\0${source.appName ?? source.appIndex}`;
         if (reconciledGroups.has(groupKey)) continue;
         reconciledGroups.add(groupKey);
         await this.refreshConfigBeforeStart(container, "resurrect", true);
       }

       const states = Array.from(this.processes.values()).map((container) =>
         container.getState()
       );
       if (states.length > 0) this.processMonitor.start();
       return states;
     } catch {
       return [];
     }
   }
 
   async startEcosystem(config: EcosystemConfig): Promise<ProcessState[]> {
     const states: ProcessState[] = [];
     for (const [appIndex, app] of config.apps.entries()) {
       const configSource = config.configFile
         ? {
             type: "config-file" as const,
             path: config.configFile,
             appIndex,
             appName: app.name,
           }
         : app.configSource;
       const result = await this.start(
         { ...app, configSource },
         {
           source: config.configFile ? "config-file" : "cli",
           trigger: "start",
           configFile: config.configFile,
           summary: config.configFile
             ? "Registered from ecosystem config"
             : "Started from CLI/API ecosystem options",
         }
       );
       states.push(...result);
     }
     return states;
   }

   getConfigHistory(
     target: string | number,
     limit = 100
   ): ConfigHistoryEntry[] {
     const container = this.resolveTarget(target)[0];
     return container
       ? this.historyStore.listForConfig(container.config, limit)
       : [];
   }
 
   async sendSignal(target: string | number, signal: string): Promise<void> {
     for (const c of this.resolveTarget(target)) {
       await c.sendSignal(signal);
     }
   }
 
   async getMetrics(): Promise<MetricSnapshot> {
     return this.monitor.takeSnapshot(this.list());
   }
 
   getPrometheusMetrics(): string {
     return this.monitor.generatePrometheusMetrics(this.list());
   }
 
   getMetricsHistory(seconds: number = 300): MetricSnapshot[] {
     return this.monitor.getHistory(seconds);
   }
 
   async reset(target: string | number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     for (const c of containers) {
       c.restartCount = 0;
       c.unstableRestarts = 0;
     }
     return containers.map((c) => c.getState());
   }

   private stopProcessMonitorWhenIdle(): void {
     const hasOnlineProcess = Array.from(this.processes.values()).some(
       (process) => process.getMonitoringPid() !== null
     );
     if (!hasOnlineProcess) this.processMonitor.stop();
   }

   private latestConfigHistoryIds(
     containers: ProcessContainer[]
   ): Set<number> {
     return new Set(
       containers.flatMap((container) => {
         const latest = this.historyStore.listForConfig(container.config, 1)[0];
         return latest ? [latest.id] : [];
       })
     );
   }

   private configReloadNoticesSince(
     containers: ProcessContainer[],
     previousHistoryIds: Set<number>
   ): ConfigReloadNotice[] {
     const notices = new Map<
       string,
       { notice: ConfigReloadNotice; changedFields: Set<string> }
     >();
     const seenHistoryIds = new Set<number>();

     for (const container of containers) {
       const latest = this.historyStore.listForConfig(container.config, 1)[0];
       if (
         !latest ||
         previousHistoryIds.has(latest.id) ||
         seenHistoryIds.has(latest.id) ||
         latest.source !== "config-file" ||
         latest.trigger !== "restart" ||
         latest.summary !== "bm2.config.json changed" ||
         latest.changes.length === 0 ||
         !latest.configFile
       ) {
         continue;
       }
       seenHistoryIds.add(latest.id);

       const source = latest.config.configSource;
       const processName =
         latest.config.instances > 1
           ? latest.processName.replace(/-\d+$/, "")
           : latest.processName;
       const serviceKey = [
         latest.configFile,
         source?.appIndex ?? source?.appName ?? processName,
       ].join("\0");
       const existing = notices.get(serviceKey);
       const changedFields =
         existing?.changedFields ??
         new Set<string>();
       for (const change of latest.changes) changedFields.add(change.field);

       notices.set(serviceKey, {
         notice: {
           processName,
           configFile: latest.configFile,
           changedFields: [],
         },
         changedFields,
       });
     }

     return Array.from(notices.values()).map(({ notice, changedFields }) => ({
       ...notice,
       changedFields: Array.from(changedFields).sort(),
     }));
   }

   private expandConfigGroups(
     originalContainers: ProcessContainer[]
   ): ProcessContainer[] {
     const originalIds = new Set(originalContainers.map(({ id }) => id));
     const configGroups = originalContainers.flatMap((container) => {
       const source = container.config.configSource;
       return source?.type === "config-file" && source.path
         ? [
             {
               path: source.path,
               app: source.appName ?? source.appIndex,
             },
           ]
         : [];
     });

     return Array.from(this.processes.values()).filter((container) => {
       if (originalIds.has(container.id)) return true;
       const source = container.config.configSource;
       return (
         source?.type === "config-file" &&
         source.path !== undefined &&
         configGroups.some(
           (group) =>
             group.path === source.path &&
             group.app === (source.appName ?? source.appIndex)
         )
       );
     });
   }
 
   private resolveTarget(target: string | number): ProcessContainer[] {
     
     if (target === "all") {
       return Array.from(this.processes.values());
     }
 
     if (typeof target === "number" || /^\d+$/.test(String(target))) {
       const id = typeof target === "number" ? target : parseInt(target);
       const proc = this.processes.get(id);
       return proc ? [proc] : [];
     }
 
     // Match by name or namespace
     return Array.from(this.processes.values()).filter(
       (p) =>
         p.name === target ||
         p.name.startsWith(`${target}-`) ||
         p.config.namespace === target
     );
   }
 }
