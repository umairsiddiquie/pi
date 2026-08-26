#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline";

const VERSION = "0.1.0";
const MCP_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30_000;

const tools = [
  {
    name: "urpc_health",
    description: "Return the health of the local URPC plug or its configured upstream.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "urpc_call",
    description: "Invoke an allowlisted URPC method on the configured URPC upstream.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", minLength: 1 },
        params: { type: "object" },
      },
      required: ["method"],
      additionalProperties: false,
    },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  write({ jsonrpc: "2.0", id, error });
}

function textResult(text, isError = false, structuredContent) {
  const result = { content: [{ type: "text", text }], isError };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function allowedMethods() {
  const raw = process.env.URPC_ALLOWED_METHODS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

function assertAllowed(method) {
  const allowed = allowedMethods();
  if (allowed && !allowed.has(method)) {
    throw new Error(`URPC method is not allowlisted: ${method}`);
  }
}

async function fetchJson(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`URPC upstream returned non-JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(`URPC upstream returned HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function invokeStdio(method, params, timeoutMs) {
  const command = process.env.URPC_COMMAND;
  if (!command) throw new Error("URPC upstream is not configured; set URPC_URL or URPC_COMMAND");

  let args = [];
  if (process.env.URPC_ARGS) {
    args = JSON.parse(process.env.URPC_ARGS);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error("URPC_ARGS must be a JSON array of strings");
    }
  }

  const child = spawn(command, args, {
    cwd: process.env.URPC_CWD || process.cwd(),
    env: { ...process.env, URPC_BRIDGE: "pi-urpc" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`URPC stdio request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.end();
          done(resolve, message);
        }
      } catch {
        // Ignore non-JSON diagnostic lines from the upstream process.
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.on("error", (error) => done(reject, error));
    child.on("exit", (code, signal) => {
      if (!settled && code !== 0) {
        done(reject, new Error(`URPC process exited (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
  });
}

async function urpcRequest(method, params = {}) {
  assertAllowed(method);
  const timeoutMs = Number(process.env.URPC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const payload = { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };

  if (process.env.URPC_URL) {
    return await fetchJson(process.env.URPC_URL, payload, timeoutMs);
  }
  return await invokeStdio(method, params, timeoutMs);
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (typeof method !== "string") return;
  if (method.startsWith("notifications/")) return;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "pi-urpc", version: VERSION },
        instructions: "URPC is exposed through a thin MCP bridge. MCP lifecycle, auth and caching remain owned by pi-mcp-adapter.",
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "urpc_health") {
        if (!process.env.URPC_URL && !process.env.URPC_COMMAND) {
          return ok(id, textResult("pi-urpc bridge healthy; no URPC upstream configured.", false, { status: "healthy", upstream: false }));
        }
        try {
          const result = await urpcRequest("health", {});
          return ok(id, textResult(JSON.stringify(result), false, { status: "healthy", upstream: true, response: result }));
        } catch (error) {
          return ok(id, textResult(String(error?.message || error), true, { status: "degraded", upstream: true }));
        }
      }
      if (name === "urpc_call") {
        if (typeof args.method !== "string" || !args.method) {
          return ok(id, textResult("method is required", true));
        }
        try {
          const result = await urpcRequest(args.method, args.params ?? {});
          return ok(id, textResult(JSON.stringify(result), false, result));
        } catch (error) {
          return ok(id, textResult(String(error?.message || error), true));
        }
      }
      return fail(id, -32602, `Unknown tool: ${String(name)}`);
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(null, -32700, message);
  }
});
