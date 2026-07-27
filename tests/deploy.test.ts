import { describe, expect, test } from "bun:test";
import {
  DeployManager,
  parseSshOptions,
  shellQuote,
} from "../src/deploy";
import type { DeployConfig } from "../src/types";

function deployConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    user: "deploy",
    host: "example.com",
    ref: "origin/main",
    repo: "git@example.com:org/app.git",
    path: "/srv/app",
    ...overrides,
  };
}

function captureRemoteCommands(manager: DeployManager): string[] {
  const commands: string[] = [];
  (manager as any).remoteExec = async (
    _target: string,
    command: string
  ): Promise<string> => {
    commands.push(command);
    return command.startsWith("test -d ") ? "no\n" : "";
  };
  return commands;
}

describe("deployment command safety", () => {
  test("quotes shell arguments without changing their value", async () => {
    const value = `repo'; printf pwned; echo '$(touch /tmp/nope)`;
    const process = Bun.spawn(["sh", "-c", `printf %s ${shellQuote(value)}`], {
      stdout: "pipe",
    });

    expect(await new Response(process.stdout).text()).toBe(value);
    expect(await process.exited).toBe(0);
  });

  test("quotes paths, repositories, and refs in remote commands", async () => {
    const manager = new DeployManager();
    const commands = captureRemoteCommands(manager);
    const config = deployConfig({
      path: "/srv/app; touch /tmp/path-injection",
      repo: `git@example.com:org/app'$(touch /tmp/repo-injection).git`,
      ref: "main; touch /tmp/ref-injection",
    });

    await manager.deploy(config);
    const script = commands.join("\n");

    expect(script).toContain(shellQuote(config.path));
    expect(script).toContain(shellQuote(config.repo));
    expect(script).toContain(shellQuote(config.ref));
    expect(script).toContain(shellQuote(`${config.path}/source`));
  });

  test("requires caller opt-in before executing configured shell hooks", async () => {
    const manager = new DeployManager();
    const commands = captureRemoteCommands(manager);

    await expect(
      manager.deploy(deployConfig({ preDeploy: "touch /tmp/hook-ran" }))
    ).rejects.toThrow("--allow-shell-hooks");
    expect(commands).toHaveLength(0);
  });

  test("quotes environment values and isolates explicitly allowed hooks", async () => {
    const manager = new DeployManager({ allowShellHooks: true });
    const commands = captureRemoteCommands(manager);
    const environmentValue = `value'; touch /tmp/env-injection; echo '`;
    const hook = "bun install && bm2 reload ecosystem.config.json";

    await manager.deploy(
      deployConfig({
        env: { RELEASE_TOKEN: environmentValue },
        postDeploy: hook,
      })
    );
    const postDeployCommand = commands.find((command) =>
      command.includes("RELEASE_TOKEN=")
    );

    expect(postDeployCommand).toContain(
      `RELEASE_TOKEN=${shellQuote(environmentValue)}`
    );
    expect(postDeployCommand).toContain(`sh -c ${shellQuote(hook)}`);
  });

  test("rejects environment keys that are not shell assignment names", async () => {
    const manager = new DeployManager();
    const commands = captureRemoteCommands(manager);

    await expect(
      manager.deploy(deployConfig({ env: { "BAD; touch /tmp/nope": "value" } }))
    ).rejects.toThrow("Invalid deployment environment variable name");
    expect(commands).toHaveLength(0);
  });

  test("parses safe SSH arguments and rejects executable SSH options", () => {
    expect(parseSshOptions("-p 2222 -o StrictHostKeyChecking=no")).toEqual([
      "-p",
      "2222",
      "-o",
      "StrictHostKeyChecking=no",
    ]);
    expect(() => parseSshOptions("-o ProxyCommand=sh")).toThrow(
      "execute local code"
    );
    expect(() => parseSshOptions(["-F", "attacker.conf"])).toThrow(
      "executable configuration"
    );
    expect(() => parseSshOptions("attacker.example command")).toThrow(
      "Unexpected positional SSH argument"
    );
  });
});
