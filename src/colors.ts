import pc from "picocolors";

const formatters: Record<string, (text: string) => string> = {
  reset: pc.reset,
  bold: pc.bold,
  dim: pc.dim,
  red: pc.red,
  green: pc.green,
  yellow: pc.yellow,
  blue: pc.blue,
  cyan: pc.cyan,
  magenta: pc.magenta,
  white: pc.white,
  gray: pc.gray,
};

export function color(text: string, type: string) {
  return formatters[type]?.(text) ?? text;
}

export function statusColor(status: string): string {
  switch (status) {
    case "online":
      return "green";
    case "stopped":
      return "gray";
    case "errored":
      return "red";
    case "launching":
    case "waiting-restart":
      return "yellow";
    case "stopping":
      return "magenta";
    default:
      return "white";
  }
}
