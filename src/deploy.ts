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
import type { DeployConfig } from "./types";

export interface DeployManagerOptions {
  /**
   * Deployment hooks are shell programs and therefore require a separate,
   * explicit opt-in from the caller rather than trust declared by the config.
   */
  allowShellHooks?: boolean;
}

const SSH_FLAGS_WITHOUT_VALUE = new Set([
  "4", "6", "A", "a", "C", "f", "G", "g", "K", "k", "M", "N", "n",
  "q", "s", "T", "t", "V", "v", "X", "x", "Y", "y",
]);
const SSH_FLAGS_WITH_VALUE = new Set([
  "B", "b", "c", "D", "E", "e", "i", "J", "L", "l", "m", "O", "o",
  "p", "Q", "R", "S", "W", "w",
]);
const EXECUTABLE_SSH_OPTIONS = new Set([
  "include",
  "knownhostscommand",
  "localcommand",
  "pkcs11provider",
  "proxycommand",
  "remotecommand",
  "securitykeyprovider",
]);

export function shellQuote(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Shell arguments must be strings");
  }
  if (value.includes("\0")) {
    throw new Error("Shell arguments cannot contain NUL bytes");
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * Parse the legacy whitespace-delimited form without invoking a shell. Use an
 * array when an individual SSH option value contains whitespace.
 */
export function parseSshOptions(options?: string | string[]): string[] {
  const tokens = Array.isArray(options)
    ? [...options]
    : options?.trim()
      ? options.trim().split(/\s+/)
      : [];
  const parsed: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (typeof token !== "string" || token.includes("\0")) {
      throw new Error("SSH options must be strings without NUL bytes");
    }
    if (!token.startsWith("-") || token === "-" || token === "--") {
      throw new Error(`Unexpected positional SSH argument: ${token}`);
    }

    const flags = token.slice(1);
    let consumed = false;

    for (let flagIndex = 0; flagIndex < flags.length; flagIndex++) {
      const flag = flags[flagIndex]!;
      if (SSH_FLAGS_WITHOUT_VALUE.has(flag)) {
        parsed.push(`-${flag}`);
        continue;
      }
      if (!SSH_FLAGS_WITH_VALUE.has(flag)) {
        if (flag === "F" || flag === "I") {
          throw new Error(`SSH option -${flag} is not allowed because it can load executable configuration`);
        }
        throw new Error(`Unsupported SSH option: -${flag}`);
      }

      const inlineValue = flags.slice(flagIndex + 1);
      const value = inlineValue || tokens[++index];
      if (value === undefined || value.includes("\0")) {
        throw new Error(`SSH option -${flag} requires a value`);
      }
      if (flag === "o") {
        const optionName = value.split(/[=\s]/, 1)[0]!.toLowerCase();
        if (EXECUTABLE_SSH_OPTIONS.has(optionName)) {
          throw new Error(`SSH option ${optionName} is not allowed because it can execute local code`);
        }
      }
      parsed.push(`-${flag}`, value);
      consumed = true;
      break;
    }

    if (!consumed && flags.length === 0) {
      throw new Error(`Invalid SSH option: ${token}`);
    }
  }

  return parsed;
}

function validateTargetPart(label: "user" | "host", value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("-") ||
    value.includes("@") ||
    /[\s\0]/.test(value)
  ) {
    throw new Error(`Invalid SSH ${label}: ${JSON.stringify(value)}`);
  }
}

function validateDeployConfig(config: DeployConfig): void {
  validateTargetPart("user", config.user);
  const hosts = Array.isArray(config.host) ? config.host : [config.host];
  if (hosts.length === 0) throw new Error("At least one deployment host is required");
  for (const host of hosts) validateTargetPart("host", host);

  if (typeof config.path !== "string" || !config.path.trim() || config.path.trim() === "/") {
    throw new Error("Deployment path must be a non-root path");
  }
  if (typeof config.repo !== "string" || !config.repo) {
    throw new Error("Deployment repository is required");
  }
  if (typeof config.ref !== "string" || !config.ref || config.ref.startsWith("-")) {
    throw new Error("Deployment ref must be non-empty and cannot start with '-'");
  }

  // Validate all values before connecting so malformed data cannot cause a
  // partially completed multi-host deployment.
  shellQuote(config.path);
  shellQuote(config.repo);
  shellQuote(config.ref);
  for (const [key, value] of Object.entries(config.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid deployment environment variable name: ${key}`);
    }
    shellQuote(value);
  }
}

export class DeployManager {
  private readonly allowShellHooks: boolean;

  constructor(options: DeployManagerOptions = {}) {
    this.allowShellHooks = options.allowShellHooks === true;
  }

  async deploy(config: DeployConfig): Promise<void> {
    this.prepare(config, [config.preDeploy, config.postDeploy]);
    const hosts = Array.isArray(config.host) ? config.host : [config.host];
    const sshOpts = parseSshOptions(config.ssh_options);

    for (const host of hosts) {
      const target = `${config.user}@${host}`;
      console.log(`\n[bm2] Deploying to ${target}...`);

      const remotePath = config.path;
      const currentPath = `${remotePath}/current`;
      const sourcePath = `${remotePath}/source`;

      if (config.preDeploy) {
        console.log(`[bm2] Running trusted pre-deploy hook: ${config.preDeploy}`);
        await this.localExec(config.preDeploy);
      }

      await this.remoteExec(
        target,
        `mkdir -p -- ${shellQuote(remotePath)} ${shellQuote(sourcePath)}`,
        sshOpts
      );

      const hasRepo = await this.remoteExec(
        target,
        `test -d ${shellQuote(`${sourcePath}/.git`)} && echo yes || echo no`,
        sshOpts
      );

      if (hasRepo.trim() === "yes") {
        await this.remoteExec(
          target,
          `cd ${shellQuote(sourcePath)} && git fetch --all && git reset --hard ${shellQuote(config.ref)} --`,
          sshOpts
        );
      } else {
        await this.remoteExec(
          target,
          `git clone -- ${shellQuote(config.repo)} ${shellQuote(sourcePath)} && cd ${shellQuote(sourcePath)} && git checkout ${shellQuote(config.ref)} --`,
          sshOpts
        );
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const releasePath = `${remotePath}/releases/${timestamp}`;

      await this.remoteExec(
        target,
        `mkdir -p -- ${shellQuote(`${remotePath}/releases`)} && cp -r -- ${shellQuote(sourcePath)} ${shellQuote(releasePath)}`,
        sshOpts
      );

      await this.remoteExec(
        target,
        `rm -f -- ${shellQuote(currentPath)} && ln -s -- ${shellQuote(releasePath)} ${shellQuote(currentPath)}`,
        sshOpts
      );

      if (config.postDeploy) {
        console.log(`[bm2] Running trusted post-deploy hook: ${config.postDeploy}`);
        const envArgs = Object.entries(config.env || {})
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(" ");
        const envPrefix = envArgs ? `env ${envArgs} ` : "";
        await this.remoteExec(
          target,
          `cd ${shellQuote(currentPath)} && ${envPrefix}sh -c ${shellQuote(config.postDeploy)}`,
          sshOpts
        );
      }

      await this.remoteExec(
        target,
        `cd ${shellQuote(`${remotePath}/releases`)} && ls -dt -- */ | tail -n +6 | xargs rm -rf --`,
        sshOpts
      );

      console.log(`[bm2] ✓ Deploy to ${target} complete`);
    }
  }

  async setup(config: DeployConfig): Promise<void> {
    this.prepare(config, [config.preSetup, config.postSetup]);
    const hosts = Array.isArray(config.host) ? config.host : [config.host];
    const sshOpts = parseSshOptions(config.ssh_options);

    for (const host of hosts) {
      const target = `${config.user}@${host}`;
      console.log(`[bm2] Setting up ${target}...`);

      await this.remoteExec(
        target,
        [
          "mkdir -p --",
          shellQuote(config.path),
          shellQuote(`${config.path}/releases`),
          shellQuote(`${config.path}/source`),
          shellQuote(`${config.path}/shared`),
        ].join(" "),
        sshOpts
      );

      if (config.preSetup) {
        await this.remoteExec(
          target,
          `sh -c ${shellQuote(config.preSetup)}`,
          sshOpts
        );
      }

      const sourcePath = `${config.path}/source`;
      await this.remoteExec(
        target,
        `git clone -- ${shellQuote(config.repo)} ${shellQuote(sourcePath)} && cd ${shellQuote(sourcePath)} && git checkout ${shellQuote(config.ref)} --`,
        sshOpts
      );

      if (config.postSetup) {
        await this.remoteExec(
          target,
          `cd ${shellQuote(sourcePath)} && sh -c ${shellQuote(config.postSetup)}`,
          sshOpts
        );
      }

      console.log(`[bm2] ✓ Setup complete for ${target}`);
    }
  }

  private prepare(
    config: DeployConfig,
    configuredHooks: Array<string | undefined>
  ): void {
    validateDeployConfig(config);
    parseSshOptions(config.ssh_options);

    if (configuredHooks.some(Boolean) && !this.allowShellHooks) {
      throw new Error(
        "Deployment hooks are shell code. Review the config and explicitly allow them with --allow-shell-hooks."
      );
    }
  }

  private async remoteExec(target: string, command: string, sshOpts: string[]): Promise<string> {
    const proc = Bun.spawn(["ssh", ...sshOpts, "--", target, command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `[bm2] Remote command failed (${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`
      );
    }
    if (stdout.trim()) console.log(stdout.trim());
    return stdout;
  }

  private async localExec(command: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `[bm2] Local hook failed (${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`
      );
    }
    if (stdout.trim()) console.log(stdout.trim());
    return stdout;
  }
}
