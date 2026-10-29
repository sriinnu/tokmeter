# Installing the Tokmeter MCP server

Instructions for an AI agent installing this server on a user's machine.

Tokmeter reads the session files AI coding agents already write to disk
(Claude Code, Codex, Cursor, Gemini CLI and 20 more) and answers questions about
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

For Claude Code, don't edit a settings file: run
`claude mcp add tokmeter --scope user -- npx -y @sriinnu/tokmeter-mcp serve`.
Claude Code keeps MCP servers in `~/.claude.json` and ignores `mcpServers` in
`~/.claude/settings.json`.

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
- Every tool is read-only. `tokmeter_cleanup_preview` shows what a cleanup
  would delete; the deletion itself is the user's to run, with `tokmeter
  cleanup` in a terminal.
- Costs are estimates from public price lists, not the user's bill.
