// HubSettingsRows.swift — Form rows used by HubSettings: stepper, picker,
// threshold. Each row pairs a label + help text with a small input control.
// Pure presentation; bindings come from the parent panel.

import SwiftUI

// ─── Stepper row ─────────────────────────────────────────────────────────

struct HubStepperRow: View {
    let label: String
    let helpText: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let step: Int
    let suffix: String
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(helpText)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            HStack(spacing: 6) {
                HubStepButton(icon: "minus", theme: theme, disabled: value <= range.lowerBound) {
                    let next = max(range.lowerBound, value - step)
                    if next != value {
                        withAnimation(.spring(response: 0.30, dampingFraction: 0.60)) { value = next }
                    }
                }
                Text("\(value)\(suffix)")
                    .font(.system(size: 13, weight: .bold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .frame(minWidth: 44)
                    .contentTransition(.numericText())
                HubStepButton(icon: "plus", theme: theme, disabled: value >= range.upperBound) {
                    let next = min(range.upperBound, value + step)
                    if next != value {
                        withAnimation(.spring(response: 0.30, dampingFraction: 0.60)) { value = next }
                    }
                }
            }
        }
    }
}

struct HubStepButton: View {
    let icon: String
    let theme: AppTheme
    let disabled: Bool
    let action: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(disabled ? bg.secondaryTextColor.opacity(0.4) : c.accent)
                .frame(width: 22, height: 22)
                .background(
                    Circle()
                        .fill(hovered && !disabled ? c.accent.opacity(0.18) : c.accent.opacity(0.08))
                        .overlay(Circle().stroke(c.accent.opacity(0.35), lineWidth: 0.8))
                )
                .scaleEffect(hovered && !disabled ? 1.08 : 1.0)
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .onHover { hovered = !disabled && $0 }
        .animation(.spring(response: 0.28, dampingFraction: 0.60), value: hovered)
    }
}

// ─── Picker row (enum-backed) ────────────────────────────────────────────

struct HubPickerRow<Option: Identifiable & CaseIterable & RawRepresentable & Hashable>: View
where Option.RawValue == String, Option.AllCases: RandomAccessCollection {
    let label: String
    let helpText: String
    @Binding var selection: Option
    let options: Option.AllCases
    let theme: AppTheme

    /// Each option needs a human label — we read it off a `label` property
    /// if the type has one. To stay generic, the caller types are
    /// `ConfigDefaultRange` / `ConfigDefaultSort` which both expose `label`.
    let labelProvider: ((Option) -> String)?

    init(
        label: String,
        helpText: String,
        selection: Binding<Option>,
        options: Option.AllCases,
        theme: AppTheme,
        labelProvider: ((Option) -> String)? = nil
    ) {
        self.label = label
        self.helpText = helpText
        self._selection = selection
        self.options = options
        self.theme = theme
        self.labelProvider = labelProvider
    }

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private func humanLabel(for o: Option) -> String {
        if let p = labelProvider { return p(o) }
        if let dr = o as? ConfigDefaultRange { return dr.label }
        if let ds = o as? ConfigDefaultSort { return ds.label }
        return o.rawValue.capitalized
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(helpText)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Picker("", selection: $selection) {
                ForEach(Array(options), id: \.id) { opt in
                    Text(humanLabel(for: opt)).tag(opt)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(minWidth: 140)
            .tint(c.accent)
        }
    }
}

// ─── Threshold row ───────────────────────────────────────────────────────

struct HubThresholdRow: View {
    let label: String
    let helpText: String
    @Binding var value: Double?
    let theme: AppTheme

    @State private var text: String = ""

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(helpText)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            HStack(spacing: 4) {
                Text("$")
                    .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.secondaryTextColor)
                TextField("off", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                    .font(.system(size: 12, design: theme.fonts.valueDesign))
                    .onAppear {
                        text = value.map { String(format: "%.2f", $0) } ?? ""
                    }
                    .onSubmit { commit() }
                    .onExitCommand { commit() }
            }
        }
    }

    private func commit() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed.lowercased() == "off" {
            value = nil
            text = ""
            return
        }
        if let n = Double(trimmed), n > 0 {
            value = n
            text = String(format: "%.2f", n)
        } else {
            text = value.map { String(format: "%.2f", $0) } ?? ""
        }
    }
}
