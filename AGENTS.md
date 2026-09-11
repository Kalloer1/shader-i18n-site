# MCP Servers Inventory (REVISED)

| Name                  | Type          | Description                                      | Status   | Location                                      |
|-----------------------|---------------|--------------------------------------------------|----------|-----------------------------------------------|
| open-browser-control  | MCP Server    | Browser control MCP                              | Active   | `~/.pi/agent/skills/open-browser-control/`    |
| colab-mcp             | MCP Server    | Google Colab browser connection MCP              | Active   | `~/.pi/agent/skills/colab-mcp/`               |
| chrome-devtools       | MCP Server    | Chrome DevTools protocol MCP                     | Active   | `~/.pi/agent/mcp-cache.json`                 |
| pi-mcp-adapter        | Adapter       | Pi MCP gateway adapter                           | Active   | `~/.pi/agent/npm/node_modules/pi-mcp-adapter/` |

## Notes
- All MCP servers are managed via `~/.pi/agent/mcp.json`
- Chrome DevTools MCP is auto-connected via `chrome-devtools-mcp-autoconnect.cmd`
- Tools from these MCPs are available through `mcp` and `mcp__*` proxy tools in the current session