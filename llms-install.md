# Installing the Tokmeter MCP server

Instructions for an AI agent installing this server on a user's machine.

Tokmeter reads the session files AI coding agents already write to disk
(Claude Code, Codex, Cursor, Gemini CLI and 12 more) and answers questions about
token usage and cost. It runs locally, needs **no API key, no account and no
environment variables**, and sends nothing off the machine.

## Requirements

- Node.js 18 or newer, with `npx` on `PATH`.

## Configuration

Add this server to the MCP settings file. The `serve` argument is required: the
package's default command starts a terminal dashboard, not the MCP server.

```json
{
  "mcpServers": {
    "tokmeter": {
      "command": "npx",
      "args": ["-y", "@sriinnu/tokmeter-mcp", "serve"]
    }
  }
}
```

For Cline, the settings file is `cline_mcp_settings.json`. Merge the
`tokmeter` entry into the existing `mcpServers` object rather than replacing it.

## Verify

After the client reloads, call `tokmeter_pulse` with no arguments. It returns
tokens and estimated cost across all recorded history (pass `scope: "today"`
for today only). A "NO DATA" reply is normal on a machine with no agent session
history yet; it means the server works.

## Notes for the agent

- The first call scans local session history and can take several seconds.
  Later calls are fast.
- `tokmeter_cleanup_execute` deletes session files. Never call it without
  running `tokmeter_cleanup_preview` first and getting the user's explicit
  confirmation.
- Costs are estimates from public price lists, not the user's bill.
