# pi-urpc

`pi-urpc` is the UAI Code URPC plug: a deliberately thin stdio MCP server that sits between Pi and a URPC implementation.

```text
Pi / uai-code
     |
     | MCP
     v
pi-mcp-adapter
     |
     | stdio MCP
     v
pi-urpc
     |
     +--> URPC_URL      (HTTP JSON-RPC)
     |
     +--> URPC_COMMAND  (stdio JSON-RPC)
```

## Ownership boundary

`pi-mcp-adapter` remains responsible for MCP protocol negotiation, authentication/OAuth, approvals, connection lifecycle, caching, proxy/direct-tool presentation, reconnects and Pi integration. The adapter's package-manifest mechanism is specifically intended for Pi packages that ship MCP server definitions. citeturn6search0

`pi-urpc` owns only the URPC bridge contract and transport dispatch. It does not persist credentials, implement OAuth, maintain an MCP cache, or bypass the adapter.

## Install in the repository

```sh
pi install npm:pi-mcp-adapter
pi install ./packages/uai-code/pi-urpc
```

For repository-local execution, the checked-in `mcp.json` uses `packages/uai-code/pi-urpc` as its server working directory.

## URPC transport

Set exactly one upstream transport when the bridge should forward calls:

### HTTP

```sh
export URPC_URL=https://your-urpc.example/method
export URPC_ALLOWED_METHODS=health,project.read,project.write
```

Each call is sent as a JSON-RPC 2.0 object:

```json
{
  "jsonrpc": "2.0",
  "id": "generated-by-pi-urpc",
  "method": "project.read",
  "params": {}
}
```

### stdio

```sh
export URPC_COMMAND=/absolute/path/to/your-urpc
export URPC_ARGS='["serve","--stdio"]'
export URPC_ALLOWED_METHODS=health,project.read
```

The bridge sends one JSON-RPC request followed by a newline and waits for the matching response. Diagnostics from the child are kept on stderr and are never written to MCP stdout.

`URPC_ALLOWED_METHODS` is optional. When set, it is a comma-separated fail-closed method allowlist. `URPC_TIMEOUT_MS` defaults to 30 seconds.

## MCP surface

- `urpc_health` — bridge/upstream health.
- `urpc_call` — invoke an allowlisted URPC method with an object of parameters.

The server intentionally reports the legacy MCP protocol revision `2024-11-05`; the installed adapter can negotiate in `auto` mode and retain its compatibility behavior instead of the bridge claiming support for newer protocol features it does not implement. citeturn6search0

## Tests

```sh
npm test --prefix packages/uai-code/pi-urpc
```

The tests exercise the MCP initialize handshake, tool discovery and the no-upstream health path without requiring a network service.
