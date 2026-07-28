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

import { join, dirname } from "path";
import { appendFile, rename, unlink, readdir, stat } from "fs/promises";
import { LOG_DIR, DEFAULT_LOG_MAX_SIZE, DEFAULT_LOG_RETAIN } from "./constants";
import type { LogEntry, LogItem, LogRotateOptions } from "./types";
import type { ReadableStreamController } from "bun";
import { EOL } from 'node:os';

const isoRegex: RegExp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

// [__br__] = linebreak
const nl = "[__br__]"

interface LogCursor {
  offset: number;
  inode: number;
}

export interface PreparedLogStream {
  logs: LogItem[];
  start: (onLog: (log: LogItem) => void) => () => void;
}

export class LogManager {
  
  private writeBuffers: Map<string, string[]> = new Map();
  private flushTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  getLogPaths(name: string, id: number, customOut?: string, customErr?: string) {
    return {
      outFile: customOut || join(LOG_DIR, `${name}-${id}-out.log`),
      errFile: customErr || join(LOG_DIR, `${name}-${id}-error.log`),
    };
  }
  
  
  async appendLog(filePath: string, data: string | Uint8Array) {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);

    // Buffer writes for performance
    if (!this.writeBuffers.has(filePath)) {
      this.writeBuffers.set(filePath, []);
    }
    this.writeBuffers.get(filePath)!.push(text);

    // Debounced flush
    if (!this.flushTimers.has(filePath)) {
      this.flushTimers.set(filePath, setTimeout(() => {
        this.flushBuffer(filePath);
      }, 100));
    }
  }
  
  appendJSONLog(filePath: string, msg: string): void {
    this.appendJSONLogs(filePath, [msg]);
  }

  appendJSONLogs(filePath: string, messages: readonly string[]): void {
    if (messages.length === 0) return;

    let buffer = this.writeBuffers.get(filePath);
    if (!buffer) {
      buffer = [];
      this.writeBuffers.set(filePath, buffer);
    }

    // All complete lines came from the same pipe read, so one timestamp is
    // sufficiently precise and avoids a Date allocation for every line.
    const ts = new Date().toISOString();
    for (const message of messages) {
      const log: LogEntry = {
        ts,
        msg: message.replace(/[\r\n]+/g, nl),
      };
      buffer.push(JSON.stringify(log) + "\n");
    }

    if (!this.flushTimers.has(filePath)) {
      this.flushTimers.set(
        filePath,
        setTimeout(() => this.flushBuffer(filePath), 100)
      );
    }
  }

  private async flushBuffer(filePath: string) {
    const buffer = this.writeBuffers.get(filePath);
    if (!buffer || buffer.length === 0) return;

    const content = buffer.join("");
    this.writeBuffers.set(filePath, []);
    this.flushTimers.delete(filePath);

    try {
      // Use appendFile (O_APPEND) instead of read-entire-file-then-rewrite.
      // The old Bun.write approach pulled the whole log into a JS string on
      // every flush — O(file size) memory per flush, quadratic overall.
      // appendFile seeks to EOF at the kernel level and writes only new bytes.
      await appendFile(filePath, content, { encoding: "utf8" });
    } catch (err) {
      console.error(`[bm2] Failed to write log: ${filePath}`, err);
    }
  }

  async forceFlush() {
    for (const [filePath] of this.writeBuffers) {
      await this.flushBuffer(filePath);
    }
  }
  
  private parseLine(line: string, level?: "err" | "out"): LogEntry {
    
    let newLine: LogEntry;
    
    try {
      
      newLine = JSON.parse(line) as LogEntry;
      
    } catch {
      // fallback to old format
      const ts = this.extractLogTs(line);
      const msg = line.replace(`[${ts}]`, "").trim();
      newLine = { ts, msg };
    }
    
    newLine.msg = newLine.msg.replaceAll(nl, EOL)
    newLine.level = level;
    
    return newLine;
  }
  
  private extractLogTs(line: string) {
    const match = line.match(isoRegex);
    return match?.[0] ?? ""
  }

  private async getCursor(filePath: string): Promise<LogCursor> {
    try {
      const fileStat = await stat(filePath);
      return { offset: fileStat.size, inode: fileStat.ino };
    } catch {
      return { offset: 0, inode: 0 };
    }
  }

  private async readLogTail(
    filePath: string,
    level: "err" | "out",
    lines: number,
    endOffset: number
  ): Promise<LogEntry[]> {
    if (lines <= 0 || endOffset <= 0) return [];

    const file = Bun.file(filePath);
    if (!(await file.exists())) return [];

    const chunkSize = 64 * 1024;
    let startOffset = Math.max(0, endOffset - chunkSize);
    let text = await file.slice(startOffset, endOffset).text();

    while (
      startOffset > 0 &&
      (text.match(/\n/g)?.length ?? 0) <= lines
    ) {
      const nextOffset = Math.max(0, startOffset - chunkSize);
      text =
        (await file.slice(nextOffset, startOffset).text()) +
        text;
      startOffset = nextOffset;
    }

    let rawLines = text.split(/\r?\n/).filter(Boolean);
    if (startOffset > 0) rawLines = rawLines.slice(1);

    return rawLines
      .slice(-lines)
      .map((line) => this.parseLine(line, level));
  }

  async prepareLogStream(
    name: string,
    id: number,
    lines: number = 20,
    customOut?: string,
    customErr?: string
  ): Promise<PreparedLogStream> {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    const [outCursor, errCursor] = await Promise.all([
      this.getCursor(paths.outFile),
      this.getCursor(paths.errFile),
    ]);
    const cursors = { out: outCursor, err: errCursor };

    const logs = (await Promise.all([
      this.readLogTail(paths.outFile, "out", lines, outCursor.offset),
      this.readLogTail(paths.errFile, "err", lines, errCursor.offset),
    ]))
      .flat()
      .map((log) => ({ name, id, ...log }))
      .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))
      .slice(-lines);

    return {
      logs,
      start: (onLog) => this.watchLogPaths(name, id, paths, cursors, onLog),
    };
  }

  private watchLogPaths(
    name: string,
    id: number,
    paths: { outFile: string; errFile: string },
    initialCursors: { out: LogCursor; err: LogCursor },
    onLog: (log: LogItem) => void
  ): () => void {
    const cursors = {
      out: { ...initialCursors.out },
      err: { ...initialCursors.err },
    };
    const remainders = { out: "", err: "" };
    let active = true;
    let polling = false;

    const poll = async () => {
      if (!active || polling) return;
      polling = true;

      try {
        for (const [level, filePath] of [
          ["out", paths.outFile],
          ["err", paths.errFile],
        ] as const) {
          const nextCursor = await this.getCursor(filePath);
          const cursor = cursors[level];

          if (
            nextCursor.inode !== cursor.inode ||
            nextCursor.offset < cursor.offset
          ) {
            cursor.offset = 0;
            cursor.inode = nextCursor.inode;
            remainders[level] = "";
          }

          if (nextCursor.offset === cursor.offset) continue;

          const chunk = await Bun.file(filePath)
            .slice(cursor.offset, nextCursor.offset)
            .text();
          cursor.offset = nextCursor.offset;
          cursor.inode = nextCursor.inode;

          const pendingLines = (remainders[level] + chunk).split(/\r?\n/);
          remainders[level] = pendingLines.pop() ?? "";

          for (const line of pendingLines) {
            if (!active) return;
            if (!line) continue;
            try {
              onLog({ name, id, ...this.parseLine(line, level) });
            } catch {
              return;
            }
          }
        }
      } catch {
        // A file can be replaced between stat and read during log rotation.
        // Keep the watcher alive so the next poll can recover from the new file.
      } finally {
        polling = false;
      }
    };

    const interval = setInterval(() => void poll(), 500);
    void poll();

    return () => {
      active = false;
      clearInterval(interval);
    };
  }

  async readLogs(
    name: string,
    id: number,
    lines: number = 20,
    customOut?: string,
    customErr?: string
  ): Promise<LogItem[]> {
    const prepared = await this.prepareLogStream(
      name,
      id,
      lines,
      customOut,
      customErr
    );
    return prepared.logs;
  }

  async tailLog(
    name: string,
    id: number,
    streamController: ReadableStreamDefaultController,
    signal: AbortSignal,
    customOut?: string,
    customErr?: string
  ) {
    const prepared = await this.prepareLogStream(
      name,
      id,
      0,
      customOut,
      customErr
    );
    const stop = prepared.start((log) => {
      streamController.enqueue(`data: ${JSON.stringify(log)}\n\n`);
    });

    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
  }

  async rotate(filePath: string, options: LogRotateOptions): Promise<void> {
    
    const file = Bun.file(filePath);
    
    if (!(await file.exists()) || file.size < options.maxSize) return;
  
    const bgTasks: Promise<any>[] = [];
  
    for (let i = options.retain - 1; i >= 1; i--) {
      
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
  
      if (await Bun.file(src).exists()) {
        
        await rename(src, dst);
        if (options.compress) {
          // Fire-and-forget compression doesn't block the next rename
          bgTasks.push(Bun.spawn(["gzip", "-f", dst]).exited); 
        }
      }
    }
  
    await Bun.write(filePath, ""); // Instantly truncate and reclaim space
  
    const dir = dirname(filePath);
    const baseName = filePath.split("/").pop()!;
  
    // Background cleanup
    bgTasks.push(
      readdir(dir).then(files =>
        Promise.all(
          files.filter(f => f.startsWith(`${baseName}.`)).sort().reverse()
            .slice(options.retain).map(f => unlink(join(dir, f)).catch(() => {}))
        )
      ).catch(() => {})
    );
  
    // Let Bun handle the heavy lifting in the background!
    Promise.all(bgTasks).catch(() => {}); 
  }

  async flush(name: string, id: number, customOut?: string, customErr?: string) {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    try { await Bun.write(paths.outFile, ""); } catch {}
    try { await Bun.write(paths.errFile, ""); } catch {}
  }

  async checkRotation(
    name: string,
    id: number,
    options: LogRotateOptions,
    customOut?: string,
    customErr?: string
  ) {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    await this.rotate(paths.outFile, options);
    await this.rotate(paths.errFile, options);
  }
}
