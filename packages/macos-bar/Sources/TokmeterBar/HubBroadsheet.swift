// HubBroadsheet.swift — Paper's newspaper grammar, applied to the Hub.
//
// The popover's broadsheet primitives (Broadsheet.swift) cover type, rules
// and kickers. The Hub adds window-sized controls: section titles, square
// ink buttons and fields, flat meters. Every view here is only reached when
// the theme is Paper; other themes keep their own code paths untouched.

import SwiftUI

/// Section title on Paper: an inverted kicker with an optional count.
struct HubPaperTitle: View {
    let text: String
    var count: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            Kicker(text: text, inverted: true)
            if let count {
                Text(count)
                    .font(Broadsheet.kickerFont)
                    .tracking(Broadsheet.kickerTracking)
                    .foregroundColor(Broadsheet.muted)
                    .monospacedDigit()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Small-caps label above a figure (KPI tiles, pulse columns).
struct HubPaperLabel: View {
    let text: String
    var color: Color = Broadsheet.muted

    var body: some View {
        Text(text.uppercased())
            .font(Broadsheet.kickerFont)
            .tracking(Broadsheet.kickerTracking)
            .foregroundColor(color)
            .lineLimit(1)
    }
}

/// Flat meter: an ink bar on a hairline track, square ends.
struct HubPaperMeter: View {
    let fraction: Double
    var color: Color = Broadsheet.ink
    var height: CGFloat = 3

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(Broadsheet.ink.opacity(0.12)).frame(height: height)
                Rectangle().fill(color)
                    .frame(width: max(1, geo.size.width * min(1, max(0, fraction))), height: height)
            }
            .frame(maxHeight: .infinity, alignment: .center)
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// Square-cornered box used behind Paper controls: ink outline, or filled ink
/// for the primary/selected state.
struct HubPaperBox: ViewModifier {
    var filled = false
    var lineWidth: CGFloat = 1

    func body(content: Content) -> some View {
        content
            .foregroundColor(filled ? Broadsheet.stock : Broadsheet.ink)
            .background(
                Rectangle().fill(filled ? Broadsheet.ink : Color.clear)
            )
            .overlay(Rectangle().strokeBorder(Broadsheet.ink, lineWidth: lineWidth))
    }
}

extension View {
    func hubPaperBox(filled: Bool = false, lineWidth: CGFloat = 1) -> some View {
        modifier(HubPaperBox(filled: filled, lineWidth: lineWidth))
    }
}

/// Paper button style: square, ink-outlined, tracked capitals; `primary`
/// fills with ink.
struct HubPaperButtonStyle: ButtonStyle {
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 10, weight: .heavy))
            .tracking(1.0)
            .textCase(.uppercase)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .hubPaperBox(filled: primary != configuration.isPressed)
            .contentShape(Rectangle())
    }
}

/// Paper page head: a section front. Display title, italic standfirst, a
/// dateline at the right, closed by a double rule.
struct HubPaperPageHeader: View {
    let title: String
    let subtitle: String
    var dateline: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .lastTextBaseline, spacing: 12) {
                Text(title)
                    .font(Broadsheet.display(34))
                    .foregroundColor(Broadsheet.ink)
                Spacer(minLength: 0)
                if let dateline {
                    Kicker(text: dateline, color: Broadsheet.muted)
                        .lineLimit(1)
                }
            }
            Text(subtitle)
                .font(.system(size: 13, design: .serif))
                .italic()
                .foregroundColor(Broadsheet.ink2)
            DoubleRule().padding(.top, 4)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Paper settings row text: serif label over an italic help line.
struct HubPaperRowText: View {
    let label: String
    let help: String
    var helpColor: Color = Broadsheet.muted

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 14, weight: .semibold, design: .serif))
                .foregroundColor(Broadsheet.ink)
            Text(help)
                .font(.system(size: 11, design: .serif))
                .italic()
                .foregroundColor(helpColor)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Text fields: square ink box on Paper, the system rounded border elsewhere.
struct HubFieldStyle: ViewModifier {
    let theme: AppTheme

    func body(content: Content) -> some View {
        if theme == .paper {
            content
                .textFieldStyle(.plain)
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(Rectangle().fill(Color.white.opacity(0.55)))
                .overlay(Rectangle().strokeBorder(Broadsheet.ink, lineWidth: 1))
        } else {
            content.textFieldStyle(.roundedBorder)
        }
    }
}

/// Paper toggle: a square ballot box, inked when on, with ON/OFF set as a
/// kicker so the state reads without colour.
struct HubPaperToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: 6) {
                Kicker(text: configuration.isOn ? "On" : "Off",
                       color: configuration.isOn ? Broadsheet.ink : Broadsheet.muted)
                ZStack {
                    Rectangle().fill(configuration.isOn ? Broadsheet.ink : Color.clear)
                    Rectangle().strokeBorder(Broadsheet.ink, lineWidth: 1.2)
                    if configuration.isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundColor(Broadsheet.stock)
                    }
                }
                .frame(width: 16, height: 16)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

/// Secondary buttons: square ink outline on Paper, the system bordered
/// small button elsewhere.
struct HubBorderedButton: ViewModifier {
    let theme: AppTheme

    func body(content: Content) -> some View {
        if theme == .paper {
            content.buttonStyle(HubPaperButtonStyle())
        } else {
            content.buttonStyle(.bordered).controlSize(.small)
        }
    }
}
