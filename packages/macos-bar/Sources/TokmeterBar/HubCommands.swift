// HubCommands.swift — "every tokmeter CLI command with one-click copy".
//
// Curated list of commands organized into groups (Usage / Aliases / Config /
// Snapshots / Daemon / Install / Kosha). Each row renders the command with
// a short description; click anywhere on the row to copy the exact string
// to the system clipboard. A brief "Copied" pill flashes on the copied
// row for feedback — the same pattern as the Projects tab's CLI actions.
//
// Curated in Swift for now rather than fetched from a shared commands.json.
// Small list, changes rarely; we'll promote to a single source if that
// assumption stops holding.

import AppKit
import SwiftUI

// ─── Model ────────────────────────────────────────────────────────────────

struct HubCommand: Identifiable {
    let id: String
    let name: String
    let description: String
    let example: String
}

struct HubCommandGroup: Identifiable {
    let id: String
    let title: String
    let icon: String
    let commands: [HubCommand]
}

/// The catalog. One source of truth inside the Hub — when the CLI grows,
/// add the command here. The list is sparse on flags (only the core one
/// per command) so it stays scannable; the `--help` of each subcommand
/// has the full surface.
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

// ─── Panel ────────────────────────────────────────────────────────────────

struct HubCommandsPanel: View {
    let theme: AppTheme

    /// Optional group filter. Nil = show all groups.
    @State private var selectedGroupId: String?

    /// Full-text filter. Matches name, description, or example.
    @State private var query: String = ""

    /// Which row just copied — drives the per-row "Copied" flash.
    @State private var flashed: String?

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 20) {
                header.cascadeIn(delay: 0.04)
                groupPills.cascadeIn(delay: 0.10)
                commandCards
            }
            .padding(28)
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Commands")
                .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("Every tokmeter command — click to copy, paste in your terminal.")
                .font(.system(size: 12, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }

    // MARK: - Group pills

    private var groupPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                HubGroupPill(
                    label: "All",
                    icon: "square.grid.2x2",
                    isSelected: selectedGroupId == nil,
                    theme: theme,
                    onTap: {
                        withAnimation(.spring(response: 0.38, dampingFraction: 0.60)) {
                            selectedGroupId = nil
                        }
                    }
                )
                ForEach(HubCommandCatalog.groups) { g in
                    HubGroupPill(
                        label: g.title,
                        icon: g.icon,
                        isSelected: selectedGroupId == g.id,
                        theme: theme,
                        onTap: {
                            withAnimation(.spring(response: 0.38, dampingFraction: 0.60)) {
                                selectedGroupId = g.id
                            }
                        }
                    )
                }
            }
        }
    }

    // MARK: - Cards

    @ViewBuilder
    private var commandCards: some View {
        let groups = selectedGroupId.flatMap { id in
            HubCommandCatalog.groups.filter { $0.id == id }
        } ?? HubCommandCatalog.groups

        VStack(spacing: 14) {
            ForEach(Array(groups.enumerated()), id: \.element.id) { idx, group in
                HubCommandGroupCard(
                    group: group,
                    theme: theme,
                    flashed: flashed,
                    onCopy: { cmd in copy(cmd) }
                )
                .cascadeIn(delay: 0.18 + Double(idx) * 0.04)
            }
        }
    }

    private func copy(_ cmd: HubCommand) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(cmd.example, forType: .string)
        flashed = cmd.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if flashed == cmd.id { flashed = nil }
        }
    }
}

// ─── Group pill ──────────────────────────────────────────────────────────

struct HubGroupPill: View {
    let label: String
    let icon: String
    let isSelected: Bool
    let theme: AppTheme
    let onTap: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
            }
            .foregroundColor(isSelected ? .white : bg.primaryTextColor.opacity(0.75))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(
                        isSelected
                            ? AnyShapeStyle(
                                LinearGradient(
                                    colors: [c.primary, c.secondary],
                                    startPoint: .leading, endPoint: .trailing
                                )
                            )
                            : AnyShapeStyle(Color.primary.opacity(hovered ? 0.08 : 0.05))
                    )
                    .overlay(
                        Capsule().stroke(
                            isSelected ? c.accent.opacity(0.45) : Color.clear,
                            lineWidth: 1
                        )
                    )
            )
        }
        .buttonStyle(.borderless)
        .scaleEffect(isSelected ? 1.04 : (hovered ? 1.02 : 1.0))
        .animation(.spring(response: 0.30, dampingFraction: 0.60), value: isSelected)
        .animation(.spring(response: 0.28, dampingFraction: 0.72), value: hovered)
        .onHover { hovered = $0 }
    }
}

// ─── Group card ──────────────────────────────────────────────────────────

struct HubCommandGroupCard: View {
    let group: HubCommandGroup
    let theme: AppTheme
    let flashed: String?
    let onCopy: (HubCommand) -> Void

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: group.icon)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(c.accent)
                    Text(group.title)
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    Text("\(group.commands.count)")
                        .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.gray.opacity(0.18)))
                }
                VStack(spacing: 5) {
                    ForEach(group.commands) { cmd in
                        HubCommandRow(
                            command: cmd,
                            theme: theme,
                            isFlashed: flashed == cmd.id,
                            onCopy: { onCopy(cmd) }
                        )
                    }
                }
            }
        }
    }
}

// ─── Row ─────────────────────────────────────────────────────────────────

struct HubCommandRow: View {
    let command: HubCommand
    let theme: AppTheme
    let isFlashed: Bool
    let onCopy: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onCopy) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(command.name)
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(c.accent)
                        Text("·")
                            .foregroundColor(bg.secondaryTextColor.opacity(0.6))
                        Text(command.description)
                            .font(.system(size: 11, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.primaryTextColor.opacity(0.85))
                            .lineLimit(1)
                    }
                    Text(command.example)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                ZStack {
                    Image(systemName: "doc.on.doc")
                        .opacity(isFlashed ? 0 : (hovered ? 1.0 : 0.55))
                    if isFlashed {
                        Text("Copied")
                            .font(.system(size: 9, weight: .bold, design: theme.fonts.labelDesign))
                            .foregroundColor(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(c.accent))
                            .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .foregroundColor(bg.secondaryTextColor)
                .font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(hovered ? Color.primary.opacity(bg.isLight ? 0.05 : 0.07) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 7)
                            .stroke(hovered ? c.accent.opacity(0.25) : Color.clear, lineWidth: 1)
                    )
            )
            .scaleEffect(hovered ? 1.005 : 1.0)
        }
        .buttonStyle(.borderless)
        .animation(.spring(response: 0.30, dampingFraction: 0.70), value: hovered)
        .animation(.spring(response: 0.45, dampingFraction: 0.55), value: isFlashed)
        .onHover { hovered = $0 }
        .help("Copy: \(command.example)")
    }
}
