// RatesPanel.swift — "what does each model cost me per million tokens?"
//
// A popover-wide drawer (same mechanics as CacheWalletDrawer) listing, for
// today's models or every model with usage:
//   - the list $/M for input, output, cache read, cache write (5m, and 1h
//     when it differs) — exactly the rates billing uses;
//   - where each price came from (kosha exact, a fuzzy match and its name,
//     your override, or unpriced);
//   - the estimated $/M paid (today, or all time at historical rates),
//     beside the list rates.
// A rate billing doesn't charge shows "—"; a rate billing derives from a
// rule (kosha lacks the field) is marked "*" with the rule in its tooltip.

import SwiftUI

/// Small "$/M" control that opens the rates drawer.
struct RatesButton: View {
    @Binding var isPresented: Bool
    let theme: AppTheme

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) { isPresented = true }
        } label: {
            Text("$/M")
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .overlay(
                    RoundedRectangle(cornerRadius: 3)
                        .strokeBorder(theme.backgroundMode.secondaryTextColor.opacity(0.5), lineWidth: 0.8)
                )
        }
        .buttonStyle(.plain)
        .help("Rates: what each model costs per million tokens, and where the price came from")
        .accessibilityLabel("Model rates per million tokens")
    }
}

struct RatesPanel: View {
    let theme: AppTheme
    @Binding var isPresented: Bool
    /// Changes whenever the numbers behind the cards can have changed (the
    /// popover passes a digest of today's and all-time totals and the price
    /// catalog's mtime), so an open panel follows a refresh instead of
    /// showing the figures it was opened with.
    var refreshKey: String = ""

    @State private var showAll = false
    @State private var response: RatesResponse?
    @State private var error: String?
    @State private var loading = false

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ZStack(alignment: .trailing) {
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close() }
                .transition(.opacity)

            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().opacity(0.25)
                ScrollView(.vertical, showsIndicators: true) {
                    content
                        .padding(.horizontal, 14)
                        .padding(.top, 10)
                        .padding(.bottom, 14)
                }
            }
            .frame(width: 360)
            .frame(maxHeight: .infinity)
            .background(drawerBackground)
            .overlay(
                Rectangle()
                    .frame(width: 0.6)
                    .foregroundColor(bg.secondaryTextColor.opacity(0.18)),
                alignment: .leading
            )
            .shadow(color: Color.black.opacity(0.30), radius: 18, x: -6, y: 0)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
        .task(id: LoadKey(showAll: showAll, refresh: refreshKey)) { await load() }
        // A scope switch drops the other scope's cards at once: the cards
        // beside a new "Today"/"All" label must belong to it.
        .onChange(of: showAll) { _, _ in
            response = nil
            error = nil
        }
    }

    private struct LoadKey: Hashable {
        let showAll: Bool
        let refresh: String
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("RATES · $ PER MILLION TOKENS")
                    .font(.system(size: 10.5, weight: .heavy, design: theme.fonts.labelDesign))
                    .tracking(1.2)
                    .foregroundColor(bg.primaryTextColor.opacity(0.92))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(bg.secondaryTextColor)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.escape, modifiers: [])
                .help("Close (Esc)")
                .accessibilityLabel("Close rates")
            }
            HStack(spacing: 8) {
                Text(freshnessLine)
                    .font(.system(size: 9.5, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .lineLimit(1)
                Spacer()
                scopeToggle
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var scopeToggle: some View {
        HStack(spacing: 0) {
            scopeButton("Today", active: !showAll) { showAll = false }
            scopeButton("All", active: showAll) { showAll = true }
        }
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(bg.secondaryTextColor.opacity(0.35), lineWidth: 0.6))
    }

    private func scopeButton(_ label: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 9.5, weight: active ? .bold : .regular, design: theme.fonts.bodyDesign))
                .foregroundColor(active ? bg.primaryTextColor : bg.secondaryTextColor)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(active ? bg.primaryTextColor.opacity(0.10) : Color.clear)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var freshnessLine: String {
        guard let r = response else { return "Prices from the kosha catalog" }
        if r.pricingUnavailable { return "Price catalog unavailable — overrides and saved file only" }
        guard r.registryMtime > 0 else { return "Price catalog missing" }
        let seconds = max(0, Date().timeIntervalSince1970 - r.registryMtime / 1000)
        let age: String
        if seconds < 60 { age = "just now" }
        else if seconds < 3600 { age = "\(Int(seconds / 60))m ago" }
        else if seconds < 86_400 { age = "\(Int(seconds / 3600))h ago" }
        else { age = "\(Int(seconds / 86_400))d ago" }
        return "Prices from the kosha catalog · updated \(age)"
    }

    // MARK: - Content

    /// The same rule as the model list: only Claude Code's empty
    /// `<synthetic>` placeholder is left out. A model with cost but no
    /// tokens (tool-reported spend) stays, so the cards add up to the hero.
    private func shown(_ r: RatesResponse) -> [ModelRateCard] {
        r.models.filter {
            !Fmt.isEmptySynthetic(model: $0.model, tokens: $0.usage.totalTokens, cost: $0.usage.cost)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let error, response == nil {
            message("Couldn't load rates: \(error)")
        } else if response == nil {
            message(loading ? "Loading rates…" : "")
        } else if let r = response, shown(r).isEmpty {
            message(showAll ? "No model usage recorded yet." : "No model usage today yet.")
        } else if let r = response {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(shown(r)) { card in
                    RatesCardView(card: card, theme: theme, allTime: showAll)
                }
                legend
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, design: theme.fonts.bodyDesign))
            .foregroundColor(bg.secondaryTextColor)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("* billing rule, not a published rate — hover for which.")
            Text("— not charged for this model, or no price at all.")
            Text(showAll
                 ? "Est. paid = all recorded cost ÷ all tokens, at the rates in force on each day."
                 : "Est. paid = today's cost (API estimate + tool-reported) ÷ today's tokens.")
        }
        .font(.system(size: 9, design: theme.fonts.bodyDesign))
        .foregroundColor(bg.secondaryTextColor)
        .padding(.top, 2)
    }

    // MARK: - Data

    private func load() async {
        let requestedAll = showAll
        loading = true
        defer { loading = false }
        do {
            let fetched = try await DaemonClient.shared.fetchRates(all: requestedAll)
            // A switch while this was in flight cancels it; never let a
            // late answer for the other scope land under this one's label.
            guard !Task.isCancelled, requestedAll == showAll else { return }
            response = fetched
            error = nil
        } catch is CancellationError {
            return
        } catch let urlError as URLError where urlError.code == .cancelled {
            return
        } catch {
            guard !Task.isCancelled, requestedAll == showAll else { return }
            // Keep showing the last good cards when only a refresh failed.
            self.error = error.localizedDescription
        }
    }

    @ViewBuilder
    private var drawerBackground: some View {
        if bg.usesMaterial {
            ZStack {
                Rectangle().fill(.regularMaterial)
                LinearGradient(colors: bg.gradientColors(), startPoint: .top, endPoint: .bottom)
            }
        } else {
            LinearGradient(colors: bg.gradientColors(), startPoint: .top, endPoint: .bottom)
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) { isPresented = false }
    }
}

/// One model: name, source tag, the rate grid, and the effective rate paid.
struct RatesCardView: View {
    let card: ModelRateCard
    let theme: AppTheme
    /// All scope: the paid figure is lifetime cost at historical rates,
    /// not today's.
    var allTime = false

    private var bg: BackgroundMode { theme.backgroundMode }
    private var unpriced: Bool { card.source.tier == "unpriced" }

    /// Show the 1h write column only when it carries a different number.
    private var show1h: Bool {
        guard let h = card.rates.cacheWrite1h.perMillion else { return false }
        return h != card.rates.cacheWrite.perMillion
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Fmt.shortModel(card.model))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(bg.primaryTextColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(card.model)
                Text(card.provider)
                    .font(.system(size: 9, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .lineLimit(1)
                Spacer(minLength: 4)
                sourceTag
            }
            if unpriced {
                Text(unpricedNote)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.statusWarning)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                HStack(alignment: .top, spacing: 0) {
                    cell("In", card.rates.input)
                    cell("Out", card.rates.output)
                    cell("Cache rd", card.rates.cacheRead)
                    cell(show1h ? "Write 5m" : "Cache wr", card.rates.cacheWrite)
                    if show1h { cell("Write 1h", card.rates.cacheWrite1h) }
                }
            }
            HStack(spacing: 4) {
                Text(allTime ? "Est. paid, all time · historical rates" : "Est. paid today")
                    .foregroundColor(bg.secondaryTextColor)
                Spacer()
                if let eff = card.effectivePerMillion {
                    Text("\(RateFormat.average(eff)) / M")
                        .foregroundColor(theme.costInk)
                        .fontWeight(.semibold)
                    Text("on \(Fmt.number(card.usage.totalTokens)) tok")
                        .foregroundColor(bg.secondaryTextColor)
                } else {
                    Text("—").foregroundColor(bg.secondaryTextColor)
                }
            }
            .font(.system(size: 10, design: theme.fonts.bodyDesign))
            .help(allTime
                  ? "All recorded cost for this model divided by all its tokens, each day at the rates "
                    + "in force then — so it can differ from today's list rates above."
                  : "Today's cost for this model (API estimate plus tool-reported) divided by all its "
                    + "tokens (input, output, cache). Cache reads are cheap, so a cache-heavy model pays "
                    + "far below its input rate.")
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(bg.primaryTextColor.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(bg.secondaryTextColor.opacity(0.18), lineWidth: 0.6)
        )
        .accessibilityElement(children: .combine)
    }

    /// No price now. If cost was still recorded, say where it came from
    /// instead of claiming it counts as $0.
    private var unpricedNote: String {
        guard card.usage.cost > 0 else { return "No price found. Its usage counts as $0 in every total." }
        return allTime
            ? "No price found today. Its recorded cost comes from tool reports or days priced earlier."
            : "No price found. Its cost today comes from the tool's own report, not a list rate."
    }

    private var sourceTag: some View {
        Text(card.source.label)
            .font(.system(size: 8.5, weight: .semibold, design: theme.fonts.bodyDesign))
            .foregroundColor(unpriced ? theme.statusWarning : bg.secondaryTextColor)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .overlay(
                RoundedRectangle(cornerRadius: 3)
                    .strokeBorder((unpriced ? theme.statusWarning : bg.secondaryTextColor).opacity(0.45), lineWidth: 0.6)
            )
            .help(card.source.help)
    }

    private func cell(_ label: String, _ rate: Rate) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 8.5, weight: .medium, design: theme.fonts.labelDesign))
                .foregroundColor(bg.secondaryTextColor)
                .lineLimit(1)
            Text(rate.perMillion.map { RateFormat.money($0) + (rate.derived ? "*" : "") } ?? "—")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundColor(rate.perMillion == nil ? bg.secondaryTextColor : theme.costInk)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(rate.perMillion == nil
              ? "Not charged for this model."
              : rate.derived
                ? "kosha has no rate for this; billing uses \(rate.basis ?? "a fallback rule")."
                : "Published rate from \(card.source.label).")
    }
}

enum RateFormat {
    /// "$4.00", "$0.20", "$0.125", "$12.50": at least cents, and every
    /// published sub-cent digit (up to 4 places) — a rate is never rounded.
    static func money(_ v: Double) -> String {
        if v >= 100 { return String(format: "$%.0f", v) }
        var s = String(format: "%.4f", v)
        // Trim trailing zeros, but keep two decimals.
        while s.hasSuffix("0"), let dot = s.firstIndex(of: "."), s.distance(from: dot, to: s.endIndex) > 3 {
            s.removeLast()
        }
        return "$" + s
    }

    /// An average actually paid — computed, not published, so it's rounded:
    /// cents from $1 up, three places below.
    static func average(_ v: Double) -> String {
        v >= 1 ? String(format: "$%.2f", v) : String(format: "$%.3f", v)
    }
}
