import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { Link, Route, Switch, useLocation } from "wouter";
import type {
  DashboardProcessState,
  DashboardState,
  MetricSnapshot,
  ProcessStatus,
} from "./types";

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

interface LogBatch {
  entries: LogEntry[];
  dropped: number;
}

interface SocketMessage {
  type: "state" | "logs" | "log" | "logBatch";
  target?: number | string;
  data: DashboardState | LogEntry[] | LogEntry | LogBatch;
}

export interface LogBuffer {
  logs: LogEntry[];
  retainedBytes: number;
  retainedLines: number;
  serverDropped: number;
  localDropped: number;
}

interface LogBufferOptions {
  replace?: boolean;
  serverDropped?: number;
  maxBytes?: number;
  maxEntries?: number;
  maxLines?: number;
}

interface PendingLogs {
  buffer: LogBuffer;
  hasUpdate: boolean;
  replacesCurrent: boolean;
}

interface DisplayLogLine {
  error: boolean;
  key: number;
  text: string;
  timestamp?: string;
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

// Four MiB keeps useful history without allowing a high-volume process to
// grow the dashboard indefinitely. Entry/line ceilings additionally guard
// against huge numbers of tiny or blank messages.
export const MAX_RETAINED_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_RETAINED_LOG_ENTRIES = 20_000;
export const MAX_RETAINED_LOG_LINES = 50_000;
const LOG_ENTRY_OVERHEAD_BYTES = 64;
const LOG_LINE_HEIGHT = 18;
const LOG_OVERSCAN_LINES = 12;
const LOG_FOLLOW_THRESHOLD_PX = LOG_LINE_HEIGHT * 2;
const logByteSizeCache = new WeakMap<LogEntry, number>();
const logLineCountCache = new WeakMap<LogEntry, number>();
const displayLineCache = new WeakMap<LogEntry, DisplayLogLine[]>();
let nextDisplayLineKey = 1;

export function createLogBuffer(): LogBuffer {
  return {
    logs: [],
    retainedBytes: 0,
    retainedLines: 0,
    serverDropped: 0,
    localDropped: 0,
  };
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes++;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function getLogByteSize(log: LogEntry): number {
  const cached = logByteSizeCache.get(log);
  if (cached !== undefined) return cached;

  let bytes = LOG_ENTRY_OVERHEAD_BYTES;
  for (const value of [log.name, log.ts, log.msg, log.out, log.err]) {
    if (value) bytes += utf8ByteLength(value);
  }
  logByteSizeCache.set(log, bytes);
  return bytes;
}

function countLines(value: string | undefined): number {
  if (value === undefined) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) lines++;
  }
  return lines;
}

function getLogLineCount(log: LogEntry): number {
  const cached = logLineCountCache.get(log);
  if (cached !== undefined) return cached;

  const lines =
    log.msg !== undefined
      ? countLines(log.msg)
      : Math.max(1, countLines(log.out) + countLines(log.err));
  logLineCountCache.set(log, lines);
  return lines;
}

export function appendLogEntries(
  current: LogBuffer,
  incoming: LogEntry[],
  options: LogBufferOptions = {}
): LogBuffer {
  const {
    replace = false,
    serverDropped = 0,
    maxBytes = MAX_RETAINED_LOG_BYTES,
    maxEntries = MAX_RETAINED_LOG_ENTRIES,
    maxLines = MAX_RETAINED_LOG_LINES,
  } = options;
  const logs = replace ? [...incoming] : [...current.logs, ...incoming];
  let retainedBytes = replace ? 0 : current.retainedBytes;
  let retainedLines = replace ? 0 : current.retainedLines;

  for (const log of incoming) {
    retainedBytes += getLogByteSize(log);
    retainedLines += getLogLineCount(log);
  }

  let firstRetained = 0;
  while (
    firstRetained < logs.length &&
    (retainedBytes > maxBytes ||
      retainedLines > maxLines ||
      logs.length - firstRetained > maxEntries)
  ) {
    const removed = logs[firstRetained]!;
    retainedBytes -= getLogByteSize(removed);
    retainedLines -= getLogLineCount(removed);
    firstRetained++;
  }

  return {
    logs: firstRetained === 0 ? logs : logs.slice(firstRetained),
    retainedBytes,
    retainedLines,
    serverDropped:
      (replace ? 0 : current.serverDropped) + positiveInteger(serverDropped),
    localDropped:
      (replace ? 0 : current.localDropped) + firstRetained,
  };
}

function createPendingLogs(): PendingLogs {
  return {
    buffer: createLogBuffer(),
    hasUpdate: false,
    replacesCurrent: false,
  };
}

export function getVirtualLogRange(
  lineCount: number,
  scrollTop: number,
  viewportHeight: number
): { start: number; end: number; offset: number; totalHeight: number } {
  const totalHeight = lineCount * LOG_LINE_HEIGHT;
  const overscan = LOG_OVERSCAN_LINES * LOG_LINE_HEIGHT;
  const boundedScrollTop = Math.min(
    Math.max(0, scrollTop),
    Math.max(0, totalHeight - Math.max(0, viewportHeight))
  );
  const start = Math.max(
    0,
    Math.floor((boundedScrollTop - overscan) / LOG_LINE_HEIGHT)
  );
  const end = Math.min(
    lineCount,
    Math.ceil(
      (boundedScrollTop + Math.max(0, viewportHeight) + overscan) /
        LOG_LINE_HEIGHT
    )
  );
  return {
    start,
    end: Math.max(start, end),
    offset: start * LOG_LINE_HEIGHT,
    totalHeight,
  };
}

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
    system: null,
    timestamp: 0,
  });
  const [logBuffer, setLogBuffer] = useState<LogBuffer>(createLogBuffer);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const socketRef = useRef<WebSocket | null>(null);
  const activeLogTargetRef = useRef<number | null>(null);
  const pendingLogsRef = useRef<PendingLogs>(createPendingLogs());
  const logFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const flushPendingLogs = () => {
      logFrameRef.current = null;
      const pending = pendingLogsRef.current;
      pendingLogsRef.current = createPendingLogs();
      if (!pending.hasUpdate) return;

      setLogBuffer((current) => {
        if (pending.replacesCurrent) return pending.buffer;

        const merged = appendLogEntries(current, pending.buffer.logs, {
          serverDropped: pending.buffer.serverDropped,
        });
        return {
          ...merged,
          localDropped: merged.localDropped + pending.buffer.localDropped,
        };
      });
    };

    const scheduleLogFlush = () => {
      if (logFrameRef.current === null) {
        logFrameRef.current = requestAnimationFrame(flushPendingLogs);
      }
    };

    const queueLogs = (
      entries: LogEntry[],
      serverDropped = 0,
      replace = false
    ) => {
      const pending = pendingLogsRef.current;
      if (replace) {
        pending.buffer = appendLogEntries(createLogBuffer(), entries, {
          replace: true,
          serverDropped,
        });
        pending.replacesCurrent = true;
      } else {
        pending.buffer = appendLogEntries(pending.buffer, entries, {
          serverDropped,
        });
      }
      pending.hasUpdate = true;
      scheduleLogFlush();
    };

    const connect = () => {
      const socket = new WebSocket(
        `${location.origin.replace(/^http/, "ws")}/ws`
      );
      socketRef.current = socket;

      socket.onopen = () => {
        const target = activeLogTargetRef.current;
        if (target !== null) {
          socket.send(
            JSON.stringify({ type: "getLogs", data: { target, lines: 50 } })
          );
        }
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as SocketMessage;
          if (message.type === "state") {
            const nextState = message.data as DashboardState;
            setDashboardState(nextState);
            setUpdatedAt(new Date(nextState.timestamp));
          } else if (message.type === "logs") {
            const target =
              message.target === undefined ? null : Number(message.target);
            if (
              target === null ||
              target === activeLogTargetRef.current
            ) {
              const entries = Array.isArray(message.data)
                ? (message.data as LogEntry[])
                : [];
              queueLogs(entries, 0, true);
            }
          } else if (message.type === "logBatch") {
            const target =
              message.target === undefined ? null : Number(message.target);
            const batch = message.data as LogBatch;
            if (
              (target === null ||
                target === activeLogTargetRef.current) &&
              batch &&
              Array.isArray(batch.entries)
            ) {
              queueLogs(batch.entries, batch.dropped);
            }
          } else if (message.type === "log") {
            const log = message.data as LogEntry;
            const target = Number(message.target ?? log.id);
            if (target === activeLogTargetRef.current) {
              queueLogs([log]);
            }
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
      if (logFrameRef.current !== null) {
        cancelAnimationFrame(logFrameRef.current);
        logFrameRef.current = null;
      }
      pendingLogsRef.current = createPendingLogs();
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((type: string, data: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type, data }));
    }
  }, []);

  const subscribeToLogs = useCallback((target: number) => {
    activeLogTargetRef.current = target;
    if (logFrameRef.current !== null) {
      cancelAnimationFrame(logFrameRef.current);
      logFrameRef.current = null;
    }
    pendingLogsRef.current = createPendingLogs();
    setLogBuffer(createLogBuffer());
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ type: "getLogs", data: { target, lines: 50 } })
      );
    }
  }, []);

  const unsubscribeFromLogs = useCallback(() => {
    activeLogTargetRef.current = null;
    if (logFrameRef.current !== null) {
      cancelAnimationFrame(logFrameRef.current);
      logFrameRef.current = null;
    }
    pendingLogsRef.current = createPendingLogs();
    setLogBuffer(createLogBuffer());
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "stopLogs" }));
    }
  }, []);

  return {
    dashboardState,
    logBuffer,
    send,
    subscribeToLogs,
    unsubscribeFromLogs,
    updatedAt,
  };
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

function SystemInfo({
  system,
}: {
  system: MetricSnapshot["system"] | null;
}) {
  if (!system) return null;

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
  openProcess,
  processes,
  send,
}: {
  openProcess: (id: number) => void;
  processes: DashboardProcessState[];
  send: (type: string, data: unknown) => void;
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
          const processPath = `/process/${process.pm_id}`;
          return (
            <tr
              className="process-row"
              key={process.pm_id}
              onClick={(event) => {
                const target = event.target;
                if (
                  target instanceof Element &&
                  target.closest("a, button, .actions")
                ) {
                  return;
                }
                openProcess(process.pm_id);
              }}
            >
              <td>{process.pm_id}</td>
              <td>
                <Link
                  className="process-link"
                  href={processPath}
                  onClick={(event) => event.stopPropagation()}
                >
                  {process.name}
                </Link>
              </td>
              <td>
                <span className={`status${statusClass}`}>{process.status}</span>
              </td>
              <td>{process.pid || "-"}</td>
              <td>{process.cpu.toFixed(1)}%</td>
              <td>{formatBytes(process.memory)}</td>
              <td>{process.restarts}</td>
              <td>
                {process.status === "online"
                  ? formatUptime(Date.now() - process.startedAt)
                  : "-"}
              </td>
              <td className="actions">
                <button
                  aria-label={`Restart ${process.name}`}
                  className="btn success"
                  onClick={(event) => {
                    event.stopPropagation();
                    send("restart", { target: process.pm_id });
                  }}
                  type="button"
                >
                  ↻
                </button>
                <button
                  aria-label={`Stop ${process.name}`}
                  className="btn danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    send("stop", { target: process.pm_id });
                  }}
                  type="button"
                >
                  ■
                </button>
                <Link
                  aria-label={`View logs for ${process.name}`}
                  className="btn"
                  href={processPath}
                  onClick={(event) => event.stopPropagation()}
                >
                  📋
                </Link>
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

function getDisplayLogLines(log: LogEntry): DisplayLogLine[] {
  const cached = displayLineCache.get(log);
  if (cached) return cached;

  const lines: DisplayLogLine[] = [];
  const appendLines = (
    value: string,
    error: boolean,
    timestamp?: string,
    detectTimestamp = false
  ) => {
    for (const [index, text] of value.split(/\r?\n/).entries()) {
      const detectedTimestamp = detectTimestamp
        ? text.match(/^\[([^\]]+)\]/)?.[0]
        : undefined;
      lines.push({
        error,
        key: nextDisplayLineKey++,
        text: detectedTimestamp ? text.slice(detectedTimestamp.length) : text,
        timestamp:
          detectedTimestamp ?? (index === 0 ? timestamp : undefined),
      });
    }
  };

  if (log.msg !== undefined) {
    appendLines(
      log.msg,
      log.level === "err",
      log.ts ? `[${log.ts}] ` : undefined
    );
  } else {
    if (log.out !== undefined) appendLines(log.out, false, undefined, true);
    if (log.err !== undefined) appendLines(log.err, true);
  }

  if (lines.length === 0) {
    lines.push({
      error: log.level === "err",
      key: nextDisplayLineKey++,
      text: "",
    });
  }

  displayLineCache.set(log, lines);
  return lines;
}

function LogsPanel({
  expanded = false,
  logBuffer,
  selectedProcess,
}: {
  expanded?: boolean;
  logBuffer: LogBuffer;
  selectedProcess: number | null;
}) {
  const outputRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({
    height: 400,
    scrollTop: 0,
  });
  const displayLines = useMemo(
    () => logBuffer.logs.flatMap(getDisplayLogLines),
    [logBuffer.logs]
  );
  const baseRange = getVirtualLogRange(
    displayLines.length,
    viewport.scrollTop,
    viewport.height
  );
  const virtualRange = followingRef.current
    ? getVirtualLogRange(
        displayLines.length,
        Math.max(0, baseRange.totalHeight - viewport.height),
        viewport.height
      )
    : baseRange;

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (output && followingRef.current) {
      output.scrollTop = output.scrollHeight;
    }
  }, [logBuffer.logs]);

  useEffect(() => {
    followingRef.current = true;
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [selectedProcess]);

  useEffect(() => {
    const output = outputRef.current;
    if (!output) return;

    const updateHeight = () => {
      const height = output.clientHeight;
      setViewport((current) =>
        current.height === height ? current : { ...current, height }
      );
    };
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(output);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    []
  );

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const output = outputRef.current;
      if (!output) return;

      const distanceFromBottom =
        output.scrollHeight - output.scrollTop - output.clientHeight;
      followingRef.current =
        distanceFromBottom <= LOG_FOLLOW_THRESHOLD_PX;
      const nextViewport = {
        height: output.clientHeight,
        scrollTop: output.scrollTop,
      };
      setViewport((current) =>
        current.height === nextViewport.height &&
        current.scrollTop === nextViewport.scrollTop
          ? current
          : nextViewport
      );
    });
  }, []);

  const lossMessages: string[] = [];
  if (logBuffer.serverDropped > 0) {
    lossMessages.push(
      `${logBuffer.serverDropped.toLocaleString()} log entries were skipped by the server while this dashboard connection was overloaded.`
    );
  }
  if (logBuffer.localDropped > 0) {
    lossMessages.push(
      `${logBuffer.localDropped.toLocaleString()} older entries were removed from the browser's bounded history (up to ${MAX_RETAINED_LOG_BYTES / 1024 / 1024} MiB).`
    );
  }

  return (
    <div className={`logs-panel${expanded ? " logs-panel-expanded" : ""}`}>
      <div className="logs-panel-heading">
        <h3>Live logs</h3>
        <span>
          {logBuffer.logs.length.toLocaleString()} entries ·{" "}
          {formatBytes(logBuffer.retainedBytes)} retained
        </span>
      </div>
      {lossMessages.length > 0 ? (
        <div className="log-loss-notice" role="status">
          {lossMessages.map((message) => (
            <span key={message}>{message}</span>
          ))}
          <span>The complete log files remain available on disk.</span>
        </div>
      ) : null}
      <div className="log-output" onScroll={handleScroll} ref={outputRef}>
        {displayLines.length === 0 ? (
          <div className="log-placeholder">
            {selectedProcess === null
              ? "Select a process to view logs"
              : "No logs available"}
          </div>
        ) : (
          <div
            className="log-virtual-spacer"
            style={{ height: virtualRange.totalHeight }}
          >
            <div
              className="log-virtual-window"
              style={{ transform: `translateY(${virtualRange.offset}px)` }}
            >
              {displayLines
                .slice(virtualRange.start, virtualRange.end)
                .map((line) => (
                  <div className="log-row" key={line.key}>
                    <span className={line.error ? "err" : undefined}>
                      {line.timestamp ? (
                        <span className="timestamp">{line.timestamp}</span>
                      ) : null}
                      {line.text}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
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

interface DashboardRoutesProps {
  dashboardState: DashboardState;
  hasDashboardState: boolean;
  logBuffer: LogBuffer;
  send: (type: string, data: unknown) => void;
  subscribeToLogs: (target: number) => void;
  unsubscribeFromLogs: () => void;
  updatedAt?: Date;
}

export function parseProcessId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function DashboardHeader({ updatedAt }: { updatedAt?: Date }) {
  return (
    <header className="header">
      <Link className="dashboard-brand" href="/">
        <h1>⚡ BM2 Dashboard</h1>
      </Link>
      <div className="meta">
        <span className="live-indicator" />
        Live • {updatedAt?.toLocaleTimeString() ?? "-"}
      </div>
    </header>
  );
}

function OverviewPage({
  dashboardState,
  openProcess,
  send,
  updatedAt,
}: {
  dashboardState: DashboardState;
  openProcess: (id: number) => void;
  send: (type: string, data: unknown) => void;
  updatedAt?: Date;
}) {
  const { processes, system } = dashboardState;
  const totals = useMemo(
    () =>
      processes.reduce(
        (result, process) => ({
          cpu: result.cpu + process.cpu,
          memory: result.memory + process.memory,
        }),
        { cpu: 0, memory: 0 }
      ),
    [processes]
  );
  const online = processes.filter(({ status }) => status === "online").length;
  const errored = processes.filter(({ status }) => status === "errored").length;

  return (
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
        <SystemInfo system={system} />
      </section>
      <section className="card section">
        <h3>Processes</h3>
        <ProcessTable
          openProcess={openProcess}
          processes={processes}
          send={send}
        />
      </section>
    </main>
  );
}

function ProcessDetailPage({
  hasDashboardState,
  logBuffer,
  processIdValue,
  processes,
  send,
  subscribeToLogs,
  unsubscribeFromLogs,
}: {
  hasDashboardState: boolean;
  logBuffer: LogBuffer;
  processIdValue: string | undefined;
  processes: DashboardProcessState[];
  send: (type: string, data: unknown) => void;
  subscribeToLogs: (target: number) => void;
  unsubscribeFromLogs: () => void;
}) {
  const processId = parseProcessId(processIdValue);
  const process =
    processId === null
      ? undefined
      : processes.find(({ pm_id }) => pm_id === processId);
  const activeProcessId = process?.pm_id;

  useEffect(() => {
    if (activeProcessId === undefined) return;
    subscribeToLogs(activeProcessId);
    return unsubscribeFromLogs;
  }, [activeProcessId, subscribeToLogs, unsubscribeFromLogs]);

  if (processId === null || (hasDashboardState && !process)) {
    return (
      <main className="container route-message">
        <div className="card">
          <h2>Process not found</h2>
          <p>The requested process is no longer managed by BM2.</p>
          <Link className="back-link" href="/">
            ← Back to processes
          </Link>
        </div>
      </main>
    );
  }

  if (!process) {
    return (
      <main className="container route-message">
        <div className="card">
          <h2>Loading process…</h2>
        </div>
      </main>
    );
  }

  const statusClass = KNOWN_STATUS_CLASSES.has(process.status)
    ? ` ${process.status}`
    : "";

  return (
    <main className="container process-detail-container">
      <section className="process-detail-summary">
        <div className="process-detail-identity">
          <Link className="back-link" href="/">
            ← Back to processes
          </Link>
          <div className="process-detail-title">
            <span className="process-detail-id">#{process.pm_id}</span>
            <h2>{process.name}</h2>
            <span className={`status${statusClass}`}>{process.status}</span>
          </div>
        </div>
        <dl className="process-detail-stats">
          <div>
            <dt>PID</dt>
            <dd>{process.pid || "-"}</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>{process.cpu.toFixed(1)}%</dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>{formatBytes(process.memory)}</dd>
          </div>
          <div>
            <dt>Restarts</dt>
            <dd>{process.restarts}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>
              {process.status === "online"
                ? formatUptime(Date.now() - process.startedAt)
                : "-"}
            </dd>
          </div>
        </dl>
        <div className="process-detail-actions">
          <button
            className="btn success"
            onClick={() => send("restart", { target: process.pm_id })}
            type="button"
          >
            ↻ Restart
          </button>
          <button
            className="btn danger"
            onClick={() => send("stop", { target: process.pm_id })}
            type="button"
          >
            ■ Stop
          </button>
        </div>
      </section>
      <LogsPanel
        expanded
        logBuffer={logBuffer}
        selectedProcess={process.pm_id}
      />
    </main>
  );
}

function RouteNotFoundPage() {
  return (
    <main className="container route-message">
      <div className="card">
        <h2>Page not found</h2>
        <Link className="back-link" href="/">
          ← Back to dashboard
        </Link>
      </div>
    </main>
  );
}

export function DashboardRoutes({
  dashboardState,
  hasDashboardState,
  logBuffer,
  send,
  subscribeToLogs,
  unsubscribeFromLogs,
  updatedAt,
}: DashboardRoutesProps) {
  const [, navigate] = useLocation();
  const openProcess = useCallback(
    (id: number) => navigate(`/process/${id}`),
    [navigate]
  );

  return (
    <Switch>
      <Route path="/process/:id">
        {({ id }) => (
          <ProcessDetailPage
            hasDashboardState={hasDashboardState}
            logBuffer={logBuffer}
            processIdValue={id}
            processes={dashboardState.processes}
            send={send}
            subscribeToLogs={subscribeToLogs}
            unsubscribeFromLogs={unsubscribeFromLogs}
          />
        )}
      </Route>
      <Route path="/">
        <OverviewPage
          dashboardState={dashboardState}
          openProcess={openProcess}
          send={send}
          updatedAt={updatedAt}
        />
      </Route>
      <Route>
        <RouteNotFoundPage />
      </Route>
    </Switch>
  );
}

export function DashboardApp() {
  const dashboard = useDashboardSocket();
  const [currentLocation] = useLocation();
  const processDetailClass = currentLocation.startsWith("/process/")
    ? " process-detail-shell"
    : "";

  return (
    <div className={`app-shell${processDetailClass}`}>
      <DashboardHeader updatedAt={dashboard.updatedAt} />
      <DashboardRoutes
        dashboardState={dashboard.dashboardState}
        hasDashboardState={dashboard.updatedAt !== undefined}
        logBuffer={dashboard.logBuffer}
        send={dashboard.send}
        subscribeToLogs={dashboard.subscribeToLogs}
        unsubscribeFromLogs={dashboard.unsubscribeFromLogs}
        updatedAt={dashboard.updatedAt}
      />
    </div>
  );
}

if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (!root) throw new Error("Dashboard root element is missing");
  createRoot(root).render(<DashboardApp />);
}
