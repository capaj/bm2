/**
 * Static shell for the React dashboard. Process state and logs are rendered by
 * React from WebSocket data; no process-controlled value is interpolated here.
 */
export function getDashboardHTML(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BM2 Dashboard</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <div id="root"><div class="loading">Loading BM2 dashboard…</div></div>
  <script type="module" src="/dashboard.js"></script>
</body>
</html>`;
}
