import { createHash } from "crypto";
import { dirname, extname, isAbsolute, resolve } from "path";
import type { EcosystemConfig, StartOptions } from "./types";

const executableConfigCache = new Map<
  string,
  { contentHash: string; config: EcosystemConfig }
>();

async function loadExecutableConfig(
  absolutePath: string,
  contentHash: string
): Promise<EcosystemConfig> {
  const cached = executableConfigCache.get(absolutePath);
  if (cached?.contentHash === contentHash) return cached.config;

  const marker = "__BM2_CONFIG_RESULT__";
  const loader = `
    const loaded = await import(process.argv[1]);
    const config = loaded.default || loaded;
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    process.stdout.write("\\n${marker}" + encoded);
  `;
  const child = Bun.spawn(
    [process.execPath, "-e", loader, absolutePath],
    {
      cwd: dirname(absolutePath),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Failed to load ecosystem config ${absolutePath}: ${stderr.trim() || `exit ${exitCode}`}`
    );
  }

  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Failed to read ecosystem config result: ${absolutePath}`);
  }
  const encoded = stdout.slice(markerIndex + marker.length).trim();
  const config = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8")
  ) as EcosystemConfig;
  executableConfigCache.set(absolutePath, { contentHash, config });
  return config;
}

export async function loadEcosystemConfigFile(
  filePath: string
): Promise<EcosystemConfig> {
  const absolutePath = resolve(filePath);
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    throw new Error(`Ecosystem file not found: ${absolutePath}`);
  }

  let config: EcosystemConfig;
  if (extname(absolutePath).toLowerCase() === ".json") {
    config = (await file.json()) as EcosystemConfig;
  } else {
    const contentHash = createHash("sha256")
      .update(Buffer.from(await file.arrayBuffer()))
      .digest("hex");
    config = await loadExecutableConfig(absolutePath, contentHash);
  }

  if (!config || !Array.isArray(config.apps)) {
    throw new Error(`Invalid ecosystem config: ${absolutePath}`);
  }

  const configDirectory = dirname(absolutePath);
  const apps = config.apps.map((app): StartOptions => {
    const cwd = app.cwd ? resolve(configDirectory, app.cwd) : configDirectory;
    return {
      ...app,
      cwd,
      script: isAbsolute(app.script) ? app.script : resolve(cwd, app.script),
    };
  });

  return { ...config, apps, configFile: absolutePath };
}
