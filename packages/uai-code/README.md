# UAI Code / URPC Plug

This directory contains the UAI Code integration layer for Pi.

```text
umairsiddiquie/pi
  -> packages/uai-code
     -> pi-urpc
        -> MCP server
           -> URPC transport (stdio or HTTP)
```

The plug is intentionally outside the root npm workspaces so the existing monorepo lockfile and CI remain unchanged. Install the nested Pi package explicitly after installing the MCP adapter:

```sh
pi install npm:pi-mcp-adapter
pi install ./packages/uai-code/pi-urpc
```

The MCP adapter owns MCP protocol integration, authentication, connection lifecycle, tool caching, approvals and proxy/direct-tool behavior. The `pi-urpc` package only exposes the URPC bridge as an MCP server.

See `pi-urpc/README.md` for the URPC transport contract and tests.
