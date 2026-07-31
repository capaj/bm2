import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { chmodSync, mkdirSync } from "fs";
import { dirname } from "path";
import { CONFIG_HISTORY_DB_FILE } from "./constants";
import type {
  ConfigHistoryChange,
  ConfigHistoryEntry,
  ConfigHistorySource,
  ConfigHistoryTrigger,
  ProcessDescription,
} from "./types";

export interface ConfigHistoryContext {
  source: ConfigHistorySource;
  trigger: ConfigHistoryTrigger;
  configFile?: string;
  summary: string;
}

interface HistoryRow {
  id: number;
  process_key: string;
  process_name: string;
  namespace: string | null;
  recorded_at: number;
  source: ConfigHistorySource;
  trigger: ConfigHistoryTrigger;
  config_file: string | null;
  summary: string;
  changes_json: string;
  config_json: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function serializeConfig(config: ProcessDescription): string {
  return JSON.stringify(canonicalize(config));
}

function configurationChanges(
  previous: ProcessDescription,
  current: ProcessDescription
): ConfigHistoryChange[] {
  const fields = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...fields]
    .sort()
    .flatMap((field) => {
      const before = (previous as unknown as Record<string, unknown>)[field];
      const after = (current as unknown as Record<string, unknown>)[field];
      if (JSON.stringify(canonicalize(before)) === JSON.stringify(canonicalize(after))) {
        return [];
      }
      return [{ field, before: before ?? null, after: after ?? null }];
    });
}

export function getConfigHistoryKey(config: ProcessDescription): string {
  const source = config.configSource;
  if (source?.type === "config-file" && source.path !== undefined) {
    return [
      "config-file",
      source.path,
      source.appName ?? source.appIndex ?? config.name,
      source.workerIndex ?? 0,
    ].join(":");
  }
  return ["process", config.namespace || "default", config.name].join(":");
}

function rowToEntry(row: HistoryRow): ConfigHistoryEntry {
  return {
    id: row.id,
    processKey: row.process_key,
    processName: row.process_name,
    namespace: row.namespace ?? undefined,
    recordedAt: row.recorded_at,
    source: row.source,
    trigger: row.trigger,
    configFile: row.config_file ?? undefined,
    summary: row.summary,
    changes: JSON.parse(row.changes_json) as ConfigHistoryChange[],
    config: JSON.parse(row.config_json) as ProcessDescription,
  };
}

export class ConfigHistoryStore {
  private database: Database | null = null;

  constructor(private readonly databaseFile = CONFIG_HISTORY_DB_FILE) {}

  private getDatabase(): Database {
    if (this.database) return this.database;
    if (this.databaseFile !== ":memory:") {
      mkdirSync(dirname(this.databaseFile), { recursive: true });
    }
    const database = new Database(this.databaseFile, { create: true });
    if (this.databaseFile !== ":memory:") {
      chmodSync(this.databaseFile, 0o600);
    }
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_key TEXT NOT NULL,
        process_name TEXT NOT NULL,
        namespace TEXT,
        recorded_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        trigger TEXT NOT NULL,
        config_file TEXT,
        summary TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        config_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS config_history_process_key_time
        ON config_history(process_key, recorded_at DESC, id DESC);
    `);
    this.database = database;
    return database;
  }

  record(
    config: ProcessDescription,
    context: ConfigHistoryContext
  ): ConfigHistoryEntry | null {
    const database = this.getDatabase();
    const processKey = getConfigHistoryKey(config);
    const configJson = serializeConfig(config);
    const latest = database
      .query<HistoryRow, [string]>(
        "SELECT * FROM config_history WHERE process_key = ? ORDER BY recorded_at DESC, id DESC LIMIT 1"
      )
      .get(processKey);

    if (latest?.config_json === configJson) return null;

    const changes = latest
      ? configurationChanges(
          JSON.parse(latest.config_json) as ProcessDescription,
          config
        )
      : [];
    const recordedAt = Date.now();
    const hash = createHash("sha256").update(configJson).digest("hex");
    const result = database
      .query<
        { id: number },
        [string, string, string | null, number, string, string, string | null, string, string, string, string]
      >(`
        INSERT INTO config_history (
          process_key, process_name, namespace, recorded_at, source, trigger,
          config_file, summary, config_hash, changes_json, config_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .get(
        processKey,
        config.name,
        config.namespace ?? null,
        recordedAt,
        context.source,
        context.trigger,
        context.configFile ?? null,
        context.summary,
        hash,
        JSON.stringify(changes),
        configJson
      );

    return {
      id: result!.id,
      processKey,
      processName: config.name,
      namespace: config.namespace,
      recordedAt,
      source: context.source,
      trigger: context.trigger,
      configFile: context.configFile,
      summary: context.summary,
      changes,
      config: JSON.parse(configJson) as ProcessDescription,
    };
  }

  listForConfig(config: ProcessDescription, limit = 100): ConfigHistoryEntry[] {
    return this.listForKey(getConfigHistoryKey(config), limit);
  }

  listForKey(processKey: string, limit = 100): ConfigHistoryEntry[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const safeLimit = Math.max(1, Math.min(500, normalizedLimit));
    return this.getDatabase()
      .query<HistoryRow, [string, number]>(
        "SELECT * FROM config_history WHERE process_key = ? ORDER BY recorded_at DESC, id DESC LIMIT ?"
      )
      .all(processKey, safeLimit)
      .map(rowToEntry);
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }
}
