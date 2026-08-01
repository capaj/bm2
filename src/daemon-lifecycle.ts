import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { DAEMON_PID_FILE, DAEMON_SOCKET } from "./constants";

const STARTUP_LOCK_GRACE_MS = 10_000;

export function readDaemonPid(pidFile = DAEMON_PID_FILE): number | null {
  try {
    const value = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim the PID file before touching the daemon socket. The exclusive create
 * prevents two concurrent launchers (for example systemd and the CLI) from
 * both deleting and binding the same socket.
 */
export function claimDaemonPidFile(
  pid = process.pid,
  pidFile = DAEMON_PID_FILE,
  now = Date.now()
): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidFile, "wx");
      try {
        writeSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;

      const owner = readDaemonPid(pidFile);
      if (owner && isProcessAlive(owner)) {
        throw new Error(`BM2 daemon is already running (PID ${owner})`);
      }

      // An empty, freshly-created file may belong to a launcher that was
      // pre-empted between open() and write(). Do not steal that lock.
      try {
        if (!owner && now - statSync(pidFile).mtimeMs < STARTUP_LOCK_GRACE_MS) {
          throw new Error("BM2 daemon startup is already in progress");
        }
      } catch (statError: any) {
        if (statError?.code !== "ENOENT") throw statError;
      }

      try {
        unlinkSync(pidFile);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }

  throw new Error("Could not claim the BM2 daemon PID file");
}

export function removeOwnedDaemonFiles(
  pid = process.pid,
  pidFile = DAEMON_PID_FILE,
  socket = DAEMON_SOCKET
): void {
  if (readDaemonPid(pidFile) !== pid) return;

  try {
    unlinkSync(socket);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    unlinkSync(pidFile);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function removeStaleDaemonFiles(
  pidFile = DAEMON_PID_FILE,
  socket = DAEMON_SOCKET
): void {
  const pid = readDaemonPid(pidFile);
  if (pid && isProcessAlive(pid)) return;

  for (const file of [socket, pidFile]) {
    try {
      unlinkSync(file);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function probeDaemon(socket = DAEMON_SOCKET): Promise<number | null> {
  if (!existsSync(socket)) return null;

  try {
    const response = await fetch("http://localhost/command", {
      unix: socket,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ping" }),
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return null;

    const result = await response.json() as {
      success?: boolean;
      data?: { pid?: number };
    };
    const pid = result.data?.pid;
    return result.success && Number.isSafeInteger(pid) && (pid ?? 0) > 0
      ? pid!
      : null;
  } catch {
    return null;
  }
}

export async function waitForDaemonReady(
  timeoutMs: number,
  previousPid?: number,
  socket = DAEMON_SOCKET
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const pid = await probeDaemon(socket);
    if (pid && pid !== previousPid) return pid;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  return null;
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pidFile = DAEMON_PID_FILE
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The daemon removes its owned PID file during its exit handler. This is
    // more useful than kill(pid, 0) when a service manager briefly retains the
    // old process as a zombie.
    if (readDaemonPid(pidFile) !== pid) return true;
    if (!isProcessAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return readDaemonPid(pidFile) !== pid || !isProcessAlive(pid);
}

export function parseSystemdServiceName(cgroups: string): string | null {
  const match = cgroups.match(/(?:^|\/)([^/\n]+\.service)(?:\/|$)/m);
  return match?.[1] ?? null;
}

export function getSystemdServiceName(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const cgroups = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const service = parseSystemdServiceName(cgroups);
    if (!service) return null;

    // A daemon launched from a terminal, CI worker, or another service inherits
    // that cgroup too. Only treat systemd as BM2's supervisor when BM2 is the
    // unit's actual MainPID.
    const result = Bun.spawnSync([
      "systemctl",
      "show",
      service,
      "--property=MainPID",
      "--value",
    ]);
    if (result.exitCode !== 0) return null;
    const mainPid = Number.parseInt(new TextDecoder().decode(result.stdout).trim(), 10);
    return mainPid === pid ? service : null;
  } catch {
    return null;
  }
}
