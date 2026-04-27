// HubSidebar.swift — the hub's left navigation column.
//
// Fixed-height list of HubSection items. Each row has an SF Symbol, title,
// and one-line tagline. Animations lean pixar-springy: selected item
// scales up with a real spring overshoot, icon gives a tiny wiggle, the
// accent glow pulses in with a bouncy pop.

import SwiftUI

struct HubSidebar: View {
    @Binding var selection: HubSection
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            brand

            Divider()
                .opacity(0.25)
                .padding(.horizontal, 14)

            // Cascade-in so the sidebar "arrives" with the window rather than
            // popping fully formed. Each row lands 60ms after the prior one.
            VStack(spacing: 4) {
                ForEach(Array(HubSection.allCases.enumerated()), id: \.element.id) { idx, section in
                    HubSidebarRow(
                        section: section,
                        theme: theme,
                        isSelected: selection == section
                    ) {
                        withAnimation(.spring(response: 0.55, dampingFraction: 0.62)) {
                            selection = section
                        }
                    }
                    .cascadeIn(delay: 0.10 + Double(idx) * 0.06)
                }
            }
            .padding(.horizontal, 10)

            Spacer()

            footerCaption
        }
        .padding(.top, 18)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Brand mark

    /// Top-left ♾️ mark with the product name. Matches the popover's hero lockup
    /// so the two surfaces read as the same app.
    private var brand: some View {
        HStack(spacing: 8) {
            Image(systemName: "infinity")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(
                    LinearGradient(
                        colors: [c.primary, c.secondary],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
            VStack(alignment: .leading, spacing: 0) {
                Text("Tokmeter")
                    .font(.system(size: 13, weight: .bold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("Hub")
                    .font(.system(size: 10, weight: .medium, design: theme.fonts.labelDesign))
                    .foregroundColor(c.accent)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Footer caption

    private var footerCaption: some View {
        Text("v\(appVersion)")
            .font(.system(size: 9, design: theme.fonts.bodyDesign))
            .foregroundColor(bg.secondaryTextColor)
            .padding(.horizontal, 16)
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

// MARK: - Row

/// One sidebar row. Has its own @State so only the hovered/selected row
/// re-renders, not the whole sidebar.
struct HubSidebarRow: View {
    let section: HubSection
    let theme: AppTheme
    let isSelected: Bool
    let onTap: () -> Void

    @State private var hovered = false
    /// Pixar-style "tada" wiggle on the icon when this row becomes selected.
    /// Driven by an internal counter that increments on each selection event.
    @State private var iconBounce = 0

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                // Icon pill — gets a gentle wiggle + scale pop when selected.
                ZStack {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(
                            isSelected
                                ? AnyShapeStyle(
                                    LinearGradient(
                                        colors: [c.primary.opacity(0.85), c.secondary.opacity(0.85)],
                                        startPoint: .topLeading, endPoint: .bottomTrailing
                                    )
                                )
                                : AnyShapeStyle(Color.primary.opacity(hovered ? 0.08 : 0.04))
                        )
                        .frame(width: 28, height: 28)

                    Image(systemName: section.icon)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(
                            isSelected ? .white : bg.primaryTextColor.opacity(0.75)
                        )
                        .rotationEffect(.degrees(iconBounce % 2 == 1 ? -6 : 0))
                        .scaleEffect(isSelected ? 1.0 : 0.94)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text(section.title)
                        .font(.system(size: 12, weight: isSelected ? .semibold : .medium,
                                      design: theme.fonts.labelDesign))
                        .foregroundColor(
                            isSelected ? bg.primaryTextColor : bg.primaryTextColor.opacity(0.78)
                        )
                    Text(section.tagline)
                        .font(.system(size: 9, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)

                if isSelected {
                    // Accent chevron springs in — visible anchor for which tab
                    // the user has selected.
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(c.accent)
                        .transition(.scale(scale: 0.5).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isSelected ? c.accent.opacity(0.10) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(isSelected ? c.accent.opacity(0.35) : Color.clear, lineWidth: 1)
                    )
            )
            // Pixar-style selection pop: real scale overshoot. Hover adds a
            // tiny lift on top — combined springs read as "alive".
            .scaleEffect(isSelected ? 1.03 : (hovered ? 1.02 : 1.0))
            .offset(y: hovered ? -1 : 0)
        }
        .buttonStyle(.borderless)
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        // Distinct springs for distinct states — selection gets more bounce
        // than hover so the moment-of-truth interaction feels weightier.
        .animation(.spring(response: 0.45, dampingFraction: 0.60), value: isSelected)
        .animation(.spring(response: 0.32, dampingFraction: 0.72), value: hovered)
        .onChange(of: isSelected) { _, nowSelected in
            if nowSelected {
                // Trigger the icon wiggle. Two counter increments so it tilts
                // once, then returns — a tiny "tada" on arrival.
                withAnimation(.spring(response: 0.30, dampingFraction: 0.35)) {
                    iconBounce += 1
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    withAnimation(.spring(response: 0.40, dampingFraction: 0.55)) {
                        iconBounce += 1
                    }
                }
            }
        }
    }
}
