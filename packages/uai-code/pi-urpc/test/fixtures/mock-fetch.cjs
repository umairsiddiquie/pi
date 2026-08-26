"use strict";

// Preload module (loaded via NODE_OPTIONS="--require ...") that stubs the
// global `fetch` used by server.mjs's HTTP upstream transport. This lets the
// tests exercise the real fetchJson() code path (request construction,
// non-2xx handling, non-JSON body handling, and network failures) without
// requiring a real network service, matching this package's "no network
// service required" testing goal.
//
// Controlled by the MOCK_FETCH_MODE environment variable:
//   - "ok":            echoes back the request's method/params as the result.
//   - "http-error":    resolves with a non-2xx status and a JSON error body.
//   - "non-json":      resolves with a 200 status and a non-JSON body.
//   - "network-error": rejects, simulating a connection failure.

const mode = process.env.MOCK_FETCH_MODE;

if (mode) {
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);

    if (mode === "network-error") {
      throw new Error("simulated network failure");
    }

    if (mode === "http-error") {
      return {
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "boom" } }),
      };
    }

    if (mode === "non-json") {
      return {
        ok: true,
        status: 200,
        text: async () => "not json",
      };
    }

    if (mode === "ok") {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { method: payload.method, params: payload.params },
          }),
      };
    }

    throw new Error(`Unknown MOCK_FETCH_MODE: ${mode}`);
  };
}
