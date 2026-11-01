import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = path.join(root, "server.mjs");
const mockFetch = path.join(root, "test", "fixtures", "mock-fetch.cjs");

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

// Starts the bridge with global fetch stubbed (via a --require preload) so the
// HTTP upstream code path can be exercised deterministically without needing
// a real network service. See test/fixtures/mock-fetch.cjs for the modes.
function startServerWithMockFetch(mode, env = {}) {
  return startServer({
    ...env,
    URPC_URL: "http://mock-upstream.invalid/rpc",
    NODE_OPTIONS: `--require ${mockFetch}`,
    MOCK_FETCH_MODE: mode,
  });
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

test("responds to ping with an empty result", async () => {
  const runtime = startServer();
  try {
    const response = await runtime.request({ jsonrpc: "2.0", id: 4, method: "ping" });
    assert.deepEqual(response.result, {});
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("returns a JSON-RPC error for an unknown method", async () => {
  const runtime = startServer();
  try {
    const response = await runtime.request({ jsonrpc: "2.0", id: 5, method: "not/a/real/method" });
    assert.equal(response.result, undefined);
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /Method not found: not\/a\/real\/method/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("returns a JSON-RPC error for an unknown tool name", async () => {
  const runtime = startServer();
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "not_a_real_tool", arguments: {} },
    });
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /Unknown tool: not_a_real_tool/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("does not emit a response for JSON-RPC notifications", async () => {
  const child = spawn(process.execPath, [server], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    // Give the event loop a chance to (incorrectly) emit a response before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(lines, []);
  } finally {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
});

test("replies with a JSON-RPC parse error for malformed input", async () => {
  const runtime = startServer();
  try {
    const response = await new Promise((resolve) => {
      runtime.child.stdout.once("data", (chunk) => resolve(JSON.parse(chunk.toString().trim())));
      runtime.child.stdin.write("not valid json\n");
    });
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32700);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call rejects a missing method argument", async () => {
  const runtime = startServer({ URPC_URL: "", URPC_COMMAND: "" });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "urpc_call", arguments: {} },
    });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "method is required");
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call errors when no upstream transport is configured", async () => {
  const runtime = startServer({ URPC_URL: "", URPC_COMMAND: "" });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read" } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /URPC upstream is not configured/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call is rejected when the method is not allowlisted", async () => {
  const runtime = startServer({ URPC_ALLOWED_METHODS: "health,project.read" });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.write" } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /URPC method is not allowlisted: project\.write/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call allows a method present in the allowlist", async () => {
  const runtime = startServerWithMockFetch("ok", { URPC_ALLOWED_METHODS: "project.read" });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read" } },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.result.method, "project.read");
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call forwards method and params to an HTTP upstream", async () => {
  const runtime = startServerWithMockFetch("ok");
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read", params: { path: "/tmp" } } },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.result.method, "project.read");
    assert.deepEqual(response.result.structuredContent.result.params, { path: "/tmp" });
    assert.equal(response.result.content[0].text, JSON.stringify(response.result.structuredContent));
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call surfaces a non-2xx HTTP upstream response as an error", async () => {
  const runtime = startServerWithMockFetch("http-error");
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read" } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /URPC upstream returned HTTP 500/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call surfaces a non-JSON HTTP upstream body as an error", async () => {
  const runtime = startServerWithMockFetch("non-json");
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read" } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /URPC upstream returned non-JSON \(200\)/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_health succeeds against a configured HTTP upstream", async () => {
  const runtime = startServerWithMockFetch("ok");
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "urpc_health", arguments: {} },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.status, "healthy");
    assert.equal(response.result.structuredContent.upstream, true);
    assert.deepEqual(response.result.structuredContent.response.result, { method: "health", params: {} });
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_health reports a degraded status when the upstream is unreachable", async () => {
  const runtime = startServerWithMockFetch("network-error");
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "urpc_health", arguments: {} },
    });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.status, "degraded");
    assert.equal(response.result.structuredContent.upstream, true);
    assert.match(response.result.content[0].text, /simulated network failure/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call forwards method and params to a stdio upstream", async () => {
  const childScript =
    "const rl=require('readline').createInterface({input:process.stdin});" +
    "rl.on('line',(l)=>{const m=JSON.parse(l);" +
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{method:m.method,params:m.params}})+'\\n');" +
    "process.exit(0);});";
  const runtime = startServer({
    URPC_URL: "",
    URPC_COMMAND: process.execPath,
    URPC_ARGS: JSON.stringify(["-e", childScript]),
  });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "echo.test", params: { a: 1 } } },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.result.method, "echo.test");
    assert.deepEqual(response.result.structuredContent.result.params, { a: 1 });
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call times out a stdio upstream that never responds", async () => {
  const childScript = "setTimeout(()=>{}, 60000);";
  const runtime = startServer({
    URPC_URL: "",
    URPC_COMMAND: process.execPath,
    URPC_ARGS: JSON.stringify(["-e", childScript]),
    URPC_TIMEOUT_MS: "150",
  });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read" } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /timed out after 150ms/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});

test("urpc_call rejects a non-array-of-strings URPC_ARGS value", async () => {
  const runtime = startServer({
    URPC_URL: "",
    URPC_COMMAND: process.execPath,
    URPC_ARGS: JSON.stringify(["valid", 123]),
  });
  try {
    const response = await runtime.request({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "urpc_call", arguments: { method: "project.read" } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /URPC_ARGS must be a JSON array of strings/);
  } finally {
    runtime.child.kill();
    await once(runtime.child, "exit").catch(() => {});
  }
});
