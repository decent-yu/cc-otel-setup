"use strict";

const fs = require("node:fs");
const path = require("node:path");

function logEvent(event, fields = {}, directory = __dirname) {
  try {
    const record = {
      ts: new Date().toISOString(),
      event,
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value ?? "").slice(0, 500)])),
    };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(directory, "ai-otel.log"), `${JSON.stringify(record)}\n`, "utf8");
  } catch (_) {
    // Telemetry diagnostics must never break the host hook.
  }
}

module.exports = { logEvent };
