import { basename } from "path";
import type { ConfigReloadNotice } from "./types";

export function formatConfigReloadNotice(notice: ConfigReloadNotice): string {
  const fields = notice.changedFields.length
    ? ` (${notice.changedFields.join(", ")})`
    : "";

  return (
    `[bm2] ${basename(notice.configFile)} changed; loaded new configuration ` +
    `for ${notice.processName}${fields}`
  );
}
