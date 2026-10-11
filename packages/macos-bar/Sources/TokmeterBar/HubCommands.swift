// HubCommands.swift — "every tokmeter CLI command with one-click copy".
//
// The Commands panel: group pills along the top filter cards; each card
// lists its commands with a one-click copy. A brief "Copied" pill flashes
// on the row that copied — same pattern as the Projects tab's CLI actions.
//
// The actual catalog is in HubCommandsCatalog.swift so this file stays
// focused on rendering.

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

    @ViewBuilder
    private var header: some View {
        if theme == .paper {
            HubPaperPageHeader(
                title: "Commands",
                subtitle: "Every tokmeter command — click to copy, paste in your terminal."
            )
        } else {
            standardHeader
        }
    }

    private var standardHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Commands")
                .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("Every tokmeter command — click to copy, paste in your terminal.")
                .font(.system(size: 12, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }

    private var groupPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                HubGroupPill(
                    label: "All",
                    icon: "square.grid.2x2",
                    isSelected: selectedGroupId == nil,
                    theme: theme,
                    onTap: {
                        // Group filter rebuilds the command list (rows added/removed);
                        // animating that structural change re-enters the constraint
                        // pass and can crash. Instant filter.
                        selectedGroupId = nil
                    }
                )
                ForEach(HubCommandCatalog.groups) { g in
                    HubGroupPill(
                        label: g.title,
                        icon: g.icon,
                        isSelected: selectedGroupId == g.id,
                        theme: theme,
                        onTap: {
                            selectedGroupId = g.id
                        }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var commandCards: some View {
        let groups = selectedGroupId.flatMap { id in
            HubCommandCatalog.groups.filter { $0.id == id }
        } ?? HubCommandCatalog.groups

        VStack(spacing: 14) {
            ForEach(groups) { group in
                HubCommandGroupCard(
                    group: group,
                    theme: theme,
                    flashed: flashed,
                    onCopy: { cmd in copy(cmd) }
                )
                // No cascadeIn here: these cards re-mount whenever the group
                // filter changes, and cascadeIn's deferred asyncAfter + implicit
                // animation, firing in a burst on restructure, re-enters the
                // window's Update-Constraints pass and crashes. Static is safe.
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
        if theme == .paper {
            // Paper: a tracked-capitals tab, inverted when selected.
            Button(action: onTap) {
                Text(label.uppercased())
                    .font(Broadsheet.kickerFont)
                    .tracking(Broadsheet.kickerTracking)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .hubPaperBox(filled: isSelected, lineWidth: isSelected || hovered ? 1 : 0.5)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .onHover { hovered = $0 }
            .accessibilityAddTraits(isSelected ? .isSelected : [])
        } else {
            standardBody
        }
    }

    private var standardBody: some View {
        Button(action: onTap) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
            }
            .foregroundColor(isSelected ? theme.onSelectedInk : bg.primaryTextColor.opacity(0.75))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(
                        isSelected
                            ? AnyShapeStyle(
                                LinearGradient(
                                    colors: theme.selectedFill,
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
                if theme == .paper {
                    HubPaperTitle(text: group.title, count: "\(group.commands.count)")
                } else {
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
                }
                VStack(spacing: theme == .paper ? 0 : 5) {
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
        if theme == .paper {
            paperBody
        } else {
            standardBody
        }
    }

    /// Paper: a listings line. Command in mono, gloss in serif, the exact
    /// invocation beneath, a hairline between entries.
    private var paperBody: some View {
        Button(action: onCopy) {
            VStack(spacing: 0) {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(command.name)
                                .font(.system(size: 12, weight: .bold, design: .monospaced))
                                .foregroundColor(Broadsheet.ink)
                            Text(command.description)
                                .font(.system(size: 12, design: .serif))
                                .foregroundColor(Broadsheet.ink2)
                                .lineLimit(1)
                        }
                        Text(command.example)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundColor(Broadsheet.muted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    if isFlashed {
                        Kicker(text: "Copied", inverted: true)
                    } else {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(Broadsheet.ink)
                            .opacity(hovered ? 1 : 0.5)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 8)
                .background(hovered ? Broadsheet.ink.opacity(0.05) : Color.clear)
                InkRule(weight: 0.5, color: Broadsheet.ink.opacity(0.3))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .onHover { hovered = $0 }
        .help("Copy: \(command.example)")
    }

    private var standardBody: some View {
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
