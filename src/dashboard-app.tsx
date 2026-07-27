import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MetricSnapshot, ProcessState, ProcessStatus } from "./types";

interface DashboardState {
  processes: ProcessState[];
  metrics?: MetricSnapshot;
}

interface LogEntry {
  id: number;
  name: string;
  ts?: string;
  msg?: string;
  level?: "out" | "err";
  // Kept for compatibility with older daemons.
  out?: string;
  err?: string;
}

interface SocketMessage {
  type: "state" | "logs";
  data: DashboardState | LogEntry[];
}

interface ChartPoint {
  cpu: number;
  memory: number;
  timestamp: number;
}

const KNOWN_STATUS_CLASSES = new Set<ProcessStatus>([
  "online",
  "stopped",
  "errored",
  "launching",
  "waiting-restart",
]);

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

function formatUptime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function useDashboardSocket() {
  const [dashboardState, setDashboardState] = useState<DashboardState>({
    processes: [],
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      const socket = new WebSocket(
        `${location.origin.replace(/^http/, "ws")}/ws`
      );
      socketRef.current = socket;

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as SocketMessage;
          if (message.type === "state") {
            setDashboardState(message.data as DashboardState);
            setUpdatedAt(new Date());
          } else if (message.type === "logs") {
            setLogs(message.data as LogEntry[]);
          }
        } catch {
          // Ignore malformed WebSocket messages and keep the connection alive.
        }
      };
      socket.onclose = () => {
        if (!disposed) reconnectTimer = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((type: string, data: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type, data }));
    }
  }, []);

  return { dashboardState, logs, send, updatedAt };
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: React.ReactNode;
  color?: "green" | "red";
}) {
  return (
    <div className="card">
      <h3>{label}</h3>
      <div className={`stat${color ? ` ${color}` : ""}`}>{value}</div>
    </div>
  );
}

function SystemInfo({ metrics }: { metrics?: MetricSnapshot }) {
  if (!metrics?.system) return null;

  const system = metrics.system;
  const memoryPercent =
    ((system.totalMemory - system.freeMemory) / system.totalMemory) * 100;
  const progressClass =
    memoryPercent > 80 ? "danger" : memoryPercent > 60 ? "warning" : "";

  return (
    <div className="system-info">
      <SystemStat label="Platform" value={system.platform} />
      <SystemStat label="CPUs" value={system.cpuCount} />
      <SystemStat label="Load (1m)" value={system.loadAvg[0]?.toFixed(2) ?? "-"} />
      <div className="sys-stat">
        <div className="label">Memory</div>
        <div className="value">{memoryPercent.toFixed(1)}%</div>
        <progress
          aria-label="Memory use"
          className={`progress ${progressClass}`}
          max={100}
          value={Math.max(0, Math.min(100, memoryPercent))}
        />
      </div>
    </div>
  );
}

function SystemStat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="sys-stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function ProcessTable({
  processes,
  send,
  viewLogs,
}: {
  processes: ProcessState[];
  send: (type: string, data: unknown) => void;
  viewLogs: (id: number) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Status</th>
          <th>PID</th>
          <th>CPU</th>
          <th>Memory</th>
          <th>Restarts</th>
          <th>Uptime</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {processes.map((process) => {
          const statusClass = KNOWN_STATUS_CLASSES.has(process.status)
            ? ` ${process.status}`
            : "";
          return (
            <tr key={process.pm_id}>
              <td>{process.pm_id}</td>
              <td>{process.name}</td>
              <td>
                <span className={`status${statusClass}`}>{process.status}</span>
              </td>
              <td>{process.pid || "-"}</td>
              <td>{process.monit.cpu.toFixed(1)}%</td>
              <td>{formatBytes(process.monit.memory)}</td>
              <td>{process.bm2_env.restart_time}</td>
              <td>
                {process.status === "online"
                  ? formatUptime(Date.now() - process.bm2_env.pm_uptime)
                  : "-"}
              </td>
              <td className="actions">
                <button
                  aria-label={`Restart ${process.name}`}
                  className="btn success"
                  onClick={() => send("restart", { target: process.pm_id })}
                  type="button"
                >
                  ↻
                </button>
                <button
                  aria-label={`Stop ${process.name}`}
                  className="btn danger"
                  onClick={() => send("stop", { target: process.pm_id })}
                  type="button"
                >
                  ■
                </button>
                <button
                  aria-label={`View logs for ${process.name}`}
                  className="btn"
                  onClick={() => viewLogs(process.pm_id)}
                  type="button"
                >
                  📋
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function LogText({ value, error = false }: { value: string; error?: boolean }) {
  return value.split("\n").map((line, index, lines) => {
    const timestamp = error ? undefined : line.match(/^\[([^\]]+)\]/)?.[0];
    return (
      <span className={error ? "err" : undefined} key={index}>
        {timestamp ? <span className="timestamp">{timestamp}</span> : null}
        {timestamp ? line.slice(timestamp.length) : line}
        {index < lines.length - 1 ? "\n" : null}
      </span>
    );
  });
}

export function LogRecord({ log }: { log: LogEntry }) {
  if (log.msg !== undefined) {
    return (
      <span className={log.level === "err" ? "err" : undefined}>
        {log.ts ? <span className="timestamp">[{log.ts}] </span> : null}
        {log.msg}
        {"\n"}
      </span>
    );
  }

  return (
    <>
      {log.out ? <LogText value={log.out} /> : null}
      {log.err ? <LogText error value={log.err} /> : null}
    </>
  );
}

function LogsPanel({
  logs,
  processes,
  selectedProcess,
  viewLogs,
}: {
  logs: LogEntry[];
  processes: ProcessState[];
  selectedProcess: number | null;
  viewLogs: (id: number) => void;
}) {
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="logs-panel">
      <h3>Logs</h3>
      <div className="tabs">
        {processes.map((process) => (
          <button
            className={`tab${selectedProcess === process.pm_id ? " active" : ""}`}
            key={process.pm_id}
            onClick={() => viewLogs(process.pm_id)}
            type="button"
          >
            {process.name}
          </button>
        ))}
      </div>
      <div className="log-output" ref={outputRef}>
        {logs.length === 0
          ? selectedProcess === null
            ? "Select a process to view logs"
            : "No logs available"
          : logs.map((log, index) => (
              <span key={`${log.id}-${index}`}>
                <LogRecord log={log} />
              </span>
            ))}
      </div>
    </div>
  );
}

function MetricsChart({ point }: { point: ChartPoint }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [history, setHistory] = useState<ChartPoint[]>([]);

  useEffect(() => {
    if (!point.timestamp) return;
    setHistory((current) => [...current, point].slice(-60));
  }, [point.cpu, point.memory, point.timestamp]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || history.length < 2) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    context.strokeStyle = "#30363d";
    context.lineWidth = 0.5;
    for (let index = 0; index < 4; index++) {
      const y = (height * index) / 4;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    const drawLine = (
      values: number[],
      maximum: number,
      color: string
    ) => {
      const stepX = width / (values.length - 1);
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.beginPath();
      values.forEach((value, index) => {
        const x = index * stepX;
        const y = height - (value / maximum) * (height - 20);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    };

    const cpuValues = history.map(({ cpu }) => cpu);
    const memoryValues = history.map(({ memory }) => memory);
    drawLine(cpuValues, Math.max(...cpuValues, 1), "#58a6ff");
    drawLine(memoryValues, Math.max(...memoryValues, 1), "#3fb950");

    const latest = history.at(-1)!;
    context.font = "11px monospace";
    context.fillStyle = "#58a6ff";
    context.fillText(`● CPU ${latest.cpu.toFixed(1)}%`, 10, 14);
    context.fillStyle = "#3fb950";
    context.fillText(`● MEM ${latest.memory.toFixed(1)}MB`, 120, 14);
  }, [history]);

  return (
    <div className="chart-container">
      <div className="chart-title">CPU &amp; Memory Over Time</div>
      <canvas ref={canvasRef} />
    </div>
  );
}

function DashboardApp() {
  const { dashboardState, logs, send, updatedAt } = useDashboardSocket();
  const [selectedProcess, setSelectedProcess] = useState<number | null>(null);
  const { processes, metrics } = dashboardState;

  const totals = useMemo(
    () =>
      processes.reduce(
        (result, process) => ({
          cpu: result.cpu + process.monit.cpu,
          memory: result.memory + process.monit.memory,
        }),
        { cpu: 0, memory: 0 }
      ),
    [processes]
  );
  const online = processes.filter(({ status }) => status === "online").length;
  const errored = processes.filter(({ status }) => status === "errored").length;

  const viewLogs = useCallback(
    (id: number) => {
      setSelectedProcess(id);
      send("getLogs", { target: id, lines: 50 });
    },
    [send]
  );

  return (
    <>
      <header className="header">
        <h1>⚡ BM2 Dashboard</h1>
        <div className="meta">
          <span className="live-indicator" />
          Live • {updatedAt?.toLocaleTimeString() ?? "-"}
        </div>
      </header>
      <main className="container">
        <div className="grid">
          <StatCard color="green" label="Online" value={online} />
          <StatCard color="red" label="Errored" value={errored} />
          <StatCard label="Total CPU" value={`${totals.cpu.toFixed(1)}%`} />
          <StatCard label="Total Memory" value={formatBytes(totals.memory)} />
        </div>
        <MetricsChart
          point={{
            cpu: totals.cpu,
            memory: totals.memory / 1024 / 1024,
            timestamp: updatedAt?.getTime() ?? 0,
          }}
        />
        <section className="card section">
          <h3>System</h3>
          <SystemInfo metrics={metrics} />
        </section>
        <section className="card section">
          <h3>Processes</h3>
          <ProcessTable processes={processes} send={send} viewLogs={viewLogs} />
        </section>
        <LogsPanel
          logs={logs}
          processes={processes}
          selectedProcess={selectedProcess}
          viewLogs={viewLogs}
        />
      </main>
    </>
  );
}

if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (!root) throw new Error("Dashboard root element is missing");
  createRoot(root).render(<DashboardApp />);
}
