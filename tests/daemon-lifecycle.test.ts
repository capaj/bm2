import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  claimDaemonPidFile,
  parseSystemdServiceName,
  readDaemonPid,
} from "../src/daemon-lifecycle";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bm2-daemon-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("daemon PID ownership", () => {
  test("claims a missing PID file", () => {
    const pidFile = join(makeTemporaryDirectory(), "daemon.pid");
    claimDaemonPidFile(process.pid, pidFile);
    expect(readDaemonPid(pidFile)).toBe(process.pid);
  });

  test("rejects a PID file owned by a live process", () => {
    const pidFile = join(makeTemporaryDirectory(), "daemon.pid");
    writeFileSync(pidFile, String(process.pid));
    expect(() => claimDaemonPidFile(process.pid + 1, pidFile)).toThrow(
      `BM2 daemon is already running (PID ${process.pid})`
    );
  });

  test("does not steal a freshly-created empty startup lock", () => {
    const pidFile = join(makeTemporaryDirectory(), "daemon.pid");
    writeFileSync(pidFile, "");
    expect(() => claimDaemonPidFile(process.pid, pidFile)).toThrow(
      "BM2 daemon startup is already in progress"
    );
  });

  test("replaces an old abandoned startup lock", () => {
    const pidFile = join(makeTemporaryDirectory(), "daemon.pid");
    writeFileSync(pidFile, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(pidFile, old, old);

    claimDaemonPidFile(process.pid, pidFile);
    expect(readDaemonPid(pidFile)).toBe(process.pid);
  });
});

test("finds a systemd service in a cgroup path", () => {
  expect(parseSystemdServiceName("0::/system.slice/bm2.service\n")).toBe("bm2.service");
  expect(parseSystemdServiceName("0::/user.slice/user-1000.slice/session-2.scope\n")).toBeNull();
});

async function runCli(home: string, ...args: string[]) {
  const cli = join(import.meta.dir, "../src/index.ts");
  const child = Bun.spawn([Bun.which("bun") || "bun", "run", cli, ...args], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("daemon reload waits for shutdown and starts one responsive replacement", async () => {
  const home = makeTemporaryDirectory();
  const pidFile = join(home, ".bm2", "daemon.pid");

  try {
    const started = await runCli(home, "daemon", "start");
    expect(started.exitCode).toBe(0);
    const oldPid = Number(readFileSync(pidFile, "utf8"));

    const reloaded = await runCli(home, "daemon", "reload");
    expect(reloaded.exitCode).toBe(0);
    expect(reloaded.stderr).toContain("Daemon stopped");

    const newPid = Number(readFileSync(pidFile, "utf8"));
    expect(newPid).not.toBe(oldPid);

    const ping = await runCli(home, "ping");
    expect(ping.exitCode).toBe(0);
    expect(ping.stdout).toContain(`PID    : ${newPid}`);
  } finally {
    await runCli(home, "kill");
  }
}, 15_000);

test("concurrent daemon starts converge on one responsive daemon", async () => {
  const home = makeTemporaryDirectory();
  const pidFile = join(home, ".bm2", "daemon.pid");

  try {
    const [first, second] = await Promise.all([
      runCli(home, "daemon", "start"),
      runCli(home, "daemon", "start"),
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const pid = Number(readFileSync(pidFile, "utf8"));
    const ping = await runCli(home, "ping");
    expect(ping.exitCode).toBe(0);
    expect(ping.stdout).toContain(`PID    : ${pid}`);
  } finally {
    await runCli(home, "kill");
  }
}, 15_000);
