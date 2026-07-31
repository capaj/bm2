import { describe, expect, test } from "bun:test";
import Daemon from "../src/daemon";
import type { ConfigReloadNotice, ProcessState } from "../src/types";

describe("daemon restart responses", () => {
  test("forward config reload notices to the CLI", async () => {
    const states = [{ name: "ai-prediction" }] as ProcessState[];
    const configReloads: ConfigReloadNotice[] = [
      {
        processName: "ai-prediction",
        configFile: "/srv/app/bm2.config.json",
        changedFields: ["args", "restartDelay"],
      },
    ];
    const daemon = new Daemon();
    daemon.initialized = true;
    daemon.pm = {
      restartDetailed: async () => ({ states, configReloads }),
    } as any;
    daemon.dashboard = {} as any;
    daemon.moduleManager = {} as any;

    const response = await daemon.handleMessage({
      type: "restart",
      data: { target: "ai-prediction" },
      id: "restart-1",
    });

    expect(response).toEqual({
      type: "restart",
      data: states,
      configReloads,
      success: true,
      id: "restart-1",
    });
  });
});
