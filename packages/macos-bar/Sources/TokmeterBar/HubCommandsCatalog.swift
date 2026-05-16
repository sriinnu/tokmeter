// HubCommandsCatalog.swift — The curated list of CLI commands shown in the
// Hub's "Commands" panel. One source of truth — when the CLI grows, add
// the command here. Sparse on flags (only the core one per command) so
// the panel stays scannable; each subcommand's `--help` has the full surface.

import Foundation

enum HubCommandCatalog {
    static let groups: [HubCommandGroup] = [
        HubCommandGroup(
            id: "usage",
            title: "Usage",
            icon: "chart.bar.doc.horizontal",
            commands: [
                .init(id: "tokmeter",
                      name: "tokmeter",
                      description: "Totals + breakdown across every provider.",
                      example: "tokmeter"),
                .init(id: "tokmeter-today",
                      name: "tokmeter --today",
                      description: "Only today's usage.",
                      example: "tokmeter --today"),
                .init(id: "tokmeter-week",
                      name: "tokmeter --week",
                      description: "Last 7 days.",
                      example: "tokmeter --week"),
                .init(id: "tokmeter-month",
                      name: "tokmeter --month",
                      description: "Current calendar month.",
                      example: "tokmeter --month"),
                .init(id: "tokmeter-daily",
                      name: "tokmeter daily",
                      description: "Full daily breakdown over the selected range.",
                      example: "tokmeter daily --month"),
                .init(id: "tokmeter-models",
                      name: "tokmeter models",
                      description: "Per-model cost and token breakdown.",
                      example: "tokmeter models"),
                .init(id: "tokmeter-projects",
                      name: "tokmeter projects",
                      description: "Per-project cost and token breakdown.",
                      example: "tokmeter projects"),
            ]
        ),

        HubCommandGroup(
            id: "alias",
            title: "Aliases",
            icon: "tag.fill",
            commands: [
                .init(id: "alias-list",
                      name: "alias list",
                      description: "Show all current aliases.",
                      example: "tokmeter alias list"),
                .init(id: "alias-set",
                      name: "alias set",
                      description: "Rename one canonical project.",
                      example: #"tokmeter alias set "old-name" "New Name""#),
                .init(id: "alias-merge",
                      name: "alias merge",
                      description: "Merge several canonical projects under one display.",
                      example: #"tokmeter alias merge "Vortex" "Vortex" "vortex""#),
                .init(id: "alias-hide",
                      name: "alias hide",
                      description: "Hide a project from per-project tables.",
                      example: #"tokmeter alias hide "old-scratch""#),
                .init(id: "alias-tag",
                      name: "alias tag",
                      description: "Add, remove, or replace tags on a display.",
                      example: #"tokmeter alias tag add "Project" work client"#),
                .init(id: "alias-suggest",
                      name: "alias suggest",
                      description: "Interactive walk-through of every project — keep / edit / reject.",
                      example: "tokmeter alias suggest"),
            ]
        ),

        HubCommandGroup(
            id: "config",
            title: "Config",
            icon: "gearshape.fill",
            commands: [
                .init(id: "config-list",
                      name: "config list",
                      description: "Show every knob with its current and default value.",
                      example: "tokmeter config list"),
                .init(id: "config-get",
                      name: "config get",
                      description: "Read one config value by dotted key.",
                      example: "tokmeter config get bar.refreshSeconds"),
                .init(id: "config-set",
                      name: "config set",
                      description: "Update one config value (validated, atomic write).",
                      example: "tokmeter config set bar.refreshSeconds 15"),
                .init(id: "config-reset",
                      name: "config reset",
                      description: "Restore one key (or all) to defaults.",
                      example: "tokmeter config reset"),
                .init(id: "config-path",
                      name: "config path",
                      description: "Print the config file path.",
                      example: "tokmeter config path"),
            ]
        ),

        HubCommandGroup(
            id: "snapshots",
            title: "Snapshots & cleanup",
            icon: "archivebox.fill",
            commands: [
                .init(id: "snapshot",
                      name: "snapshot",
                      description: "Archive (without deleting) current records — optionally filter.",
                      example: "tokmeter snapshot"),
                .init(id: "snapshot-project",
                      name: "snapshot --project",
                      description: "Snapshot only one project.",
                      example: #"tokmeter snapshot --project "Vortex""#),
                .init(id: "cleanup-dry",
                      name: "cleanup --dry-run",
                      description: "Preview what a cleanup would delete. Always run this first.",
                      example: #"tokmeter cleanup --older-than 30d --dry-run"#),
                .init(id: "cleanup",
                      name: "cleanup",
                      description: "Delete records after inspecting a dry-run preview.",
                      example: #"tokmeter cleanup --older-than 30d --backup"#),
                .init(id: "restore",
                      name: "restore",
                      description: "Restore the latest (or a specific) snapshot.",
                      example: "tokmeter restore --latest"),
            ]
        ),

        HubCommandGroup(
            id: "daemon",
            title: "Daemon",
            icon: "bolt.horizontal.circle.fill",
            commands: [
                .init(id: "daemon-start",
                      name: "daemon start",
                      description: "Start the background aggregator (powers the bar + Hub).",
                      example: "tokmeter daemon start"),
                .init(id: "daemon-status",
                      name: "daemon status",
                      description: "Show the daemon's PID, URL, and liveness.",
                      example: "tokmeter daemon status"),
                .init(id: "daemon-stop",
                      name: "daemon stop",
                      description: "Stop the running daemon.",
                      example: "tokmeter daemon stop"),
            ]
        ),

        HubCommandGroup(
            id: "install",
            title: "Install / integrations",
            icon: "square.and.arrow.down.fill",
            commands: [
                .init(id: "install-statusline",
                      name: "install-statusline",
                      description: "Wire the statusline hook into every supported editor.",
                      example: "tokmeter install-statusline"),
                .init(id: "install-mcp",
                      name: "install-mcp",
                      description: "Register the MCP server with every supported editor.",
                      example: "tokmeter install-mcp"),
                .init(id: "editors",
                      name: "editors",
                      description: "List every editor tokmeter knows how to hook into.",
                      example: "tokmeter editors"),
            ]
        ),

        HubCommandGroup(
            id: "kosha",
            title: "Pricing (Kosha)",
            icon: "dollarsign.circle.fill",
            commands: [
                .init(id: "kosha-refresh",
                      name: "kosha-refresh",
                      description: "Refresh local model price registry.",
                      example: "tokmeter kosha-refresh"),
                .init(id: "kosha-update",
                      name: "kosha-update",
                      description: "Pull upstream pricing updates and reprice today's records.",
                      example: "tokmeter kosha-update"),
            ]
        ),
    ]
}
