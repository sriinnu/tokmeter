// RestNudge.swift — a quiet "it's late" line, only when a HUMAN is up late.
//
// Agents run unattended around the clock, so token burn says nothing about
// whether anyone is at the keyboard. This never looks at usage at all: the
// only input is how long ago the keyboard, mouse or trackpad was touched.
// The nudge shows when local time is inside the late window (default
// 00:00–05:00), there was input within the last ~2 minutes, and the person
// has been at it for 20+ minutes of that window. At most once per night,
// dismissible, never in place of a number. Settings has the off switch.

import CoreGraphics
import Foundation
import SwiftUI

/// The late window, in local wall-clock hours. `endHour` is exclusive; a
/// window may wrap midnight (23 → 5). Equal hours mean an empty window.
struct LateWindow: Equatable {
    var startHour: Int
    var endHour: Int

    static let defaultStart = 0
    static let defaultEnd = 5

    func contains(hour: Int) -> Bool {
        if startHour == endHour { return false }
        if startHour < endHour { return hour >= startHour && hour < endHour }
        return hour >= startHour || hour < endHour
    }

    /// When the window instance containing `date` opened, or nil when `date`
    /// is outside the window. A wrapped window that's past midnight opened
    /// yesterday. This is what makes "once per night" exact: a nudge shown
    /// at or after this moment was shown tonight.
    func start(containing date: Date, calendar: Calendar) -> Date? {
        let hour = calendar.component(.hour, from: date)
        guard contains(hour: hour) else { return nil }
        var day = calendar.startOfDay(for: date)
        if startHour > endHour, hour < endHour,
           let yesterday = calendar.date(byAdding: .day, value: -1, to: day) {
            day = yesterday
        }
        return calendar.date(bySettingHour: startHour, minute: 0, second: 0, of: day)
    }
}

/// The decision, as pure functions of time and idle readings — no clocks, no
/// system calls — so every branch is unit-testable.
enum RestNudge {
    /// Input this recent means someone is at the machine right now.
    static let recentInputSeconds: TimeInterval = 120
    /// How long they've been at it (inside the window) before the nudge.
    static let sustainedSeconds: TimeInterval = 20 * 60
    /// A pause longer than this ends the stretch (stepping away counts).
    static let breakSeconds: TimeInterval = 5 * 60

    /// Advance the start of the current active stretch from a fresh reading.
    /// - A pause longer than `breakSeconds` ends the stretch.
    /// - So does a gap between samples longer than that (the Mac slept, the
    ///   app was suspended): continuity can't be vouched for across it.
    /// - Otherwise the stretch carries on, or begins at the last input.
    static func activeSince(previous: Date?, lastSample: Date?, now: Date,
                            idleSeconds: TimeInterval) -> Date? {
        guard idleSeconds.isFinite, idleSeconds >= 0, idleSeconds <= breakSeconds else { return nil }
        let lastInput = now.addingTimeInterval(-idleSeconds)
        if let lastSample, now.timeIntervalSince(lastSample) > breakSeconds { return lastInput }
        return previous ?? lastInput
    }

    static func shouldShow(now: Date, calendar: Calendar, window: LateWindow, enabled: Bool,
                           idleSeconds: TimeInterval, activeSince: Date?, lastShown: Date?) -> Bool {
        guard enabled, let windowStart = window.start(containing: now, calendar: calendar) else { return false }
        guard idleSeconds.isFinite, idleSeconds >= 0, idleSeconds <= recentInputSeconds else { return false }
        guard let activeSince else { return false }
        // Only time spent inside tonight's window counts.
        let stretchStart = max(activeSince, windowStart)
        guard now.timeIntervalSince(stretchStart) >= sustainedSeconds else { return false }
        if let lastShown, lastShown >= windowStart { return false }  // already shown tonight
        return true
    }
}

/// Seconds since the last physical keyboard / mouse / trackpad event.
enum SystemIdle {
    /// `.hidSystemState` rather than `.combinedSessionState`: the HID state
    /// tracks events coming up from the hardware event system, while the
    /// combined session state also folds in events software posts into the
    /// login session — automation and computer-use agents among them, which
    /// is exactly what must not read as "the person is awake". It's
    /// best-effort, not proof: an event synthesized at the HID tap can still
    /// register. The query needs no Accessibility or Input Monitoring grant;
    /// it reads a timestamp, never event contents.
    ///
    /// `CGEventType(rawValue: ~0)` is kCGAnyInputEventType: the most recent
    /// input of any kind (key, click, move, scroll).
    static func secondsSinceLastInput() -> TimeInterval {
        guard let anyInput = CGEventType(rawValue: ~0) else { return .infinity }
        return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
    }
}

/// UserDefaults keys shared by the monitor and the Settings rows.
enum RestNudgeDefaults {
    static let enabled = "restNudgeEnabled"
    static let startHour = "restNudgeStartHour"
    static let endHour = "restNudgeEndHour"
    static let lastShown = "restNudgeLastShown"
}

/// Samples idle time once a minute and raises `isShowing` when the decision
/// says so. Sampling outside the window is a no-op beyond reading the hour.
@MainActor
final class RestNudgeMonitor: ObservableObject {
    static let shared = RestNudgeMonitor()

    @Published private(set) var isShowing = false

    private let defaults: UserDefaults
    private let idleReader: () -> TimeInterval
    private let calendar: () -> Calendar
    private var activeSince: Date?
    private var lastSample: Date?
    private var timer: Timer?

    init(defaults: UserDefaults = .standard,
         idleReader: @escaping () -> TimeInterval = SystemIdle.secondsSinceLastInput,
         calendar: @escaping () -> Calendar = { Calendar.current }) {
        self.defaults = defaults
        self.idleReader = idleReader
        self.calendar = calendar
    }

    var enabled: Bool { defaults.object(forKey: RestNudgeDefaults.enabled) as? Bool ?? true }

    var window: LateWindow {
        LateWindow(startHour: defaults.object(forKey: RestNudgeDefaults.startHour) as? Int ?? LateWindow.defaultStart,
                   endHour: defaults.object(forKey: RestNudgeDefaults.endHour) as? Int ?? LateWindow.defaultEnd)
    }

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        t.tolerance = 10
        RunLoop.main.add(t, forMode: .common)
        timer = t
        tick()
    }

    func tick(now: Date = Date()) {
        let cal = calendar()
        let window = self.window
        guard enabled, window.start(containing: now, calendar: cal) != nil else {
            // Off, or daytime: forget the stretch and drop any stale line.
            activeSince = nil
            lastSample = nil
            if isShowing { isShowing = false }
            return
        }
        let idle = idleReader()
        activeSince = RestNudge.activeSince(previous: activeSince, lastSample: lastSample,
                                            now: now, idleSeconds: idle)
        lastSample = now
        guard !isShowing else { return }
        let lastShownEpoch = defaults.object(forKey: RestNudgeDefaults.lastShown) as? Double
        let lastShown = lastShownEpoch.map { Date(timeIntervalSince1970: $0) }
        if RestNudge.shouldShow(now: now, calendar: cal, window: window, enabled: true,
                                idleSeconds: idle, activeSince: activeSince, lastShown: lastShown) {
            isShowing = true
            // Persisted, so a relaunch at 03:00 doesn't nudge a second time.
            defaults.set(now.timeIntervalSince1970, forKey: RestNudgeDefaults.lastShown)
        }
    }

    func dismiss() {
        isShowing = false
    }
}

/// The popover line. One sentence, no guilt, sits above the numbers and
/// never replaces one.
struct RestNudgeLine: View {
    @ObservedObject var monitor: RestNudgeMonitor
    let theme: AppTheme

    static let message = "It's late. Everything here will keep until morning. Rest well."

    private var paper: Bool { theme == .paper }
    private var muted: Color { paper ? Broadsheet.muted : theme.backgroundMode.secondaryTextColor }

    var body: some View {
        if monitor.isShowing {
            HStack(spacing: 6) {
                Image(systemName: "moon.stars")
                    .font(.system(size: 10))
                    .foregroundColor(paper ? Broadsheet.ink : theme.colors.accent)
                    .accessibilityHidden(true)
                Text(Self.message)
                    .font(paper
                          ? .system(size: 11, design: .serif).italic()
                          : .system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(paper ? Broadsheet.ink : theme.backgroundMode.primaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button { withAnimation(.easeOut(duration: 0.2)) { monitor.dismiss() } } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(muted)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Dismiss for tonight")
                .accessibilityLabel("Dismiss for tonight")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: paper ? 0 : 8)
                    .fill(muted.opacity(0.10))
            )
            .transition(.opacity)
        }
    }
}
