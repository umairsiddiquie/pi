import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = path.join(root, "server.mjs");

function startServer(env = {}) {
  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiters.shift()?.(message);
    }
  });
  return {
    child,
    request(message) {
      return new Promise((resolve) => {
        waiters.push(resolve);
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
  };
}

test("initializes as an MCP tools server", async () => {
  const runtime = startServer();
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.equal(response.result.serverInfo.name, "pi-urpc");

    const tools = await runtime.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["urpc_health", "urpc_call"]);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("reports bridge health without an upstream", async () => {
  const runtime = startServer({ URPC_URL: "", URPC_COMMAND: "" });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "urpc_health", arguments: {} },
    });
    assert.equal(response.result.isError, false);
    assert.match(response.result.content[0].text, /bridge healthy/);
    assert.equal(response.result.structuredContent.upstream, false);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});
