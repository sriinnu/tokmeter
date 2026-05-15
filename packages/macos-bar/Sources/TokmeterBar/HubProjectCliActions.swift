// HubProjectCliActions.swift — Copy-to-clipboard CLI commands for one
// project. Lives inside HubProjectDetailView. Each row briefly flashes
// "Copied" when fired — same idiom as HubCommands.

import AppKit
import SwiftUI

/// Row of copy-to-clipboard CLI commands keyed to the current project. Each
/// row renders the command, a short explanation, and a copy button that
/// briefly flashes "Copied" for feedback.
struct HubProjectCliActions: View {
    let projectName: String
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// Which row just fired "Copied" feedback — used to animate the pill
    /// on the clicked button only, not every row.
    @State private var flashed: String?

    private var commands: [CliCommand] {
        let name = projectName
        return [
            CliCommand(
                id: "dry-run",
                icon: "trash.circle",
                title: "Preview cleanup",
                command: #"tokmeter cleanup --project "\#(name)" --dry-run"#
            ),
            CliCommand(
                id: "snapshot",
                icon: "archivebox",
                title: "Snapshot project",
                command: #"tokmeter snapshot --project "\#(name)""#
            ),
            CliCommand(
                id: "alias-rename",
                icon: "character.cursor.ibeam",
                title: "Rename via alias",
                command: #"tokmeter alias set "\#(name)" "Better Name""#
            ),
            CliCommand(
                id: "alias-hide",
                icon: "eye.slash",
                title: "Hide from tables",
                command: #"tokmeter alias hide "\#(name)""#
            ),
        ]
    }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(c.accent)
                    Text("Manage in terminal")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    Text("click to copy")
                        .font(.system(size: 9, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                }
                VStack(spacing: 6) {
                    ForEach(commands) { cmd in
                        cliRow(cmd)
                    }
                }
            }
        }
    }

    private func cliRow(_ cmd: CliCommand) -> some View {
        HubCliCommandRow(
            command: cmd,
            theme: theme,
            isFlashed: flashed == cmd.id,
            onCopy: {
                copyToClipboard(cmd.command)
                flashed = cmd.id
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    if flashed == cmd.id { flashed = nil }
                }
            }
        )
    }

    private func copyToClipboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }
}

struct CliCommand: Identifiable {
    let id: String
    let icon: String
    let title: String
    let command: String
}

struct HubCliCommandRow: View {
    let command: CliCommand
    let theme: AppTheme
    let isFlashed: Bool
    let onCopy: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onCopy) {
            HStack(spacing: 10) {
                Image(systemName: command.icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(c.accent)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(command.title)
                        .font(.system(size: 11, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Text(command.command)
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
            .padding(.vertical, 8)
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
        .help("Copy: \(command.command)")
    }
}
