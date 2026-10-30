import XCTest
@testable import TokmeterBar

/// The rest-nudge decision as pure functions: time, idle seconds, active-since
/// and last-shown in, show / don't out. A fixed calendar and zone so the
/// result never depends on the machine running the tests.
final class RestNudgeTests: XCTestCase {
    private var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return c
    }()

    private let night = LateWindow(startHour: 0, endHour: 5)

    private func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        cal.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    private func show(now: Date, idle: TimeInterval, activeSince: Date?, lastShown: Date? = nil,
                      window: LateWindow? = nil, enabled: Bool = true) -> Bool {
        RestNudge.shouldShow(now: now, calendar: cal, window: window ?? night, enabled: enabled,
                             idleSeconds: idle, activeSince: activeSince, lastShown: lastShown)
    }

    func testShowsAfterTwentyActiveMinutesLateAtNight() {
        XCTAssertTrue(show(now: at(30, 1, 30), idle: 10, activeSince: at(30, 1, 5)))
    }

    func testNotDuringTheDay() {
        XCTAssertFalse(show(now: at(30, 14), idle: 5, activeSince: at(30, 9)))
        XCTAssertFalse(show(now: at(30, 5, 0), idle: 5, activeSince: at(30, 4)), "end hour is exclusive")
    }

    /// Agents burning tokens at 03:00 with nobody at the keyboard: the input
    /// idle time is large, so no nudge, whatever the usage looks like.
    func testIdleHumanNeverNudgedEvenIfAgentsRun() {
        XCTAssertFalse(show(now: at(30, 3), idle: 3 * 3600, activeSince: nil))
        XCTAssertFalse(show(now: at(30, 3), idle: RestNudge.recentInputSeconds + 1, activeSince: at(30, 1)))
    }

    func testNeedsASustainedStretch() {
        XCTAssertFalse(show(now: at(30, 1, 30), idle: 10, activeSince: at(30, 1, 15)), "15 minutes is not 20")
        XCTAssertFalse(show(now: at(30, 1, 30), idle: 10, activeSince: nil))
    }

    /// Working since 23:00 doesn't count as 20 minutes at 00:05: only time
    /// inside tonight's window does.
    func testOnlyTimeInsideTheWindowCounts() {
        XCTAssertFalse(show(now: at(31, 0, 5), idle: 10, activeSince: at(30, 23)))
        XCTAssertTrue(show(now: at(31, 0, 20), idle: 10, activeSince: at(30, 23)))
    }

    func testOncePerNight() {
        XCTAssertFalse(show(now: at(30, 3), idle: 10, activeSince: at(30, 1), lastShown: at(30, 1, 30)))
        // Last night's nudge doesn't block tonight's.
        XCTAssertTrue(show(now: at(30, 3), idle: 10, activeSince: at(30, 1), lastShown: at(29, 2)))
    }

    func testOffSwitch() {
        XCTAssertFalse(show(now: at(30, 1, 30), idle: 10, activeSince: at(30, 1), enabled: false))
    }

    func testWindowThatWrapsMidnight() {
        let late = LateWindow(startHour: 23, endHour: 2)
        XCTAssertTrue(late.contains(hour: 23))
        XCTAssertTrue(late.contains(hour: 1))
        XCTAssertFalse(late.contains(hour: 2))
        XCTAssertFalse(late.contains(hour: 12))
        // At 01:00 the window opened yesterday at 23:00.
        XCTAssertEqual(late.start(containing: at(31, 1), calendar: cal), at(30, 23))
        // A nudge shown at 23:40 is "tonight" for 01:00 the next calendar day.
        XCTAssertFalse(show(now: at(31, 1), idle: 10, activeSince: at(30, 23), lastShown: at(30, 23, 40), window: late))
        XCTAssertTrue(show(now: at(31, 1), idle: 10, activeSince: at(30, 23), lastShown: at(30, 1), window: late))
    }

    func testEmptyWindowNeverShows() {
        let empty = LateWindow(startHour: 3, endHour: 3)
        XCTAssertFalse(empty.contains(hour: 3))
        XCTAssertFalse(show(now: at(30, 3, 30), idle: 1, activeSince: at(30, 0), window: empty))
    }

    // MARK: - Active stretch bookkeeping

    func testStretchBeginsAtLastInputAndCarriesOn() {
        let now = at(30, 1)
        let start = RestNudge.activeSince(previous: nil, lastSample: nil, now: now, idleSeconds: 30)
        XCTAssertEqual(start, now.addingTimeInterval(-30))
        let later = RestNudge.activeSince(previous: start, lastSample: now, now: now.addingTimeInterval(60),
                                          idleSeconds: 200)
        XCTAssertEqual(later, start, "a short pause keeps the stretch")
    }

    func testLongPauseEndsTheStretch() {
        XCTAssertNil(RestNudge.activeSince(previous: at(30, 1), lastSample: at(30, 1, 20), now: at(30, 1, 21),
                                           idleSeconds: RestNudge.breakSeconds + 1))
    }

    /// The Mac slept from 01:10 to 01:40: no proof of continuity across it.
    func testSamplingGapRestartsTheStretch() {
        let now = at(30, 1, 40)
        let start = RestNudge.activeSince(previous: at(30, 1), lastSample: at(30, 1, 10), now: now, idleSeconds: 5)
        XCTAssertEqual(start, now.addingTimeInterval(-5))
    }

    func testUnreadableIdleIsNotPresence() {
        XCTAssertNil(RestNudge.activeSince(previous: nil, lastSample: nil, now: at(30, 1), idleSeconds: .infinity))
        XCTAssertFalse(show(now: at(30, 1, 30), idle: .infinity, activeSince: at(30, 1)))
        XCTAssertFalse(show(now: at(30, 1, 30), idle: -1, activeSince: at(30, 1)))
    }

    // MARK: - Monitor wiring (fake idle clock, throwaway defaults)

    @MainActor
    func testMonitorShowsOnceAndPersists() {
        let suite = "RestNudgeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var idle: TimeInterval = 10
        let cal = self.cal
        let monitor = RestNudgeMonitor(defaults: defaults, idleReader: { idle }, calendar: { cal })

        for minute in stride(from: 0, through: 19, by: 1) {
            monitor.tick(now: at(30, 1, minute))
            XCTAssertFalse(monitor.isShowing, "minute \(minute)")
        }
        monitor.tick(now: at(30, 1, 21))
        XCTAssertTrue(monitor.isShowing)
        monitor.dismiss()
        monitor.tick(now: at(30, 1, 22))
        XCTAssertFalse(monitor.isShowing, "dismissed stays dismissed tonight")

        // A relaunch (fresh monitor, same defaults) doesn't nudge again.
        let relaunched = RestNudgeMonitor(defaults: defaults, idleReader: { idle }, calendar: { cal })
        for minute in stride(from: 30, through: 59, by: 1) { relaunched.tick(now: at(30, 2, minute)) }
        XCTAssertFalse(relaunched.isShowing)

        // Agents only: nobody touches the keyboard the next night.
        idle = 4 * 3600
        for minute in stride(from: 0, through: 59, by: 1) { relaunched.tick(now: at(31, 2, minute)) }
        XCTAssertFalse(relaunched.isShowing)
    }

    @MainActor
    func testMonitorRespectsTheOffSwitch() {
        let suite = "RestNudgeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: RestNudgeDefaults.enabled)
        let cal = self.cal
        let monitor = RestNudgeMonitor(defaults: defaults, idleReader: { 5 }, calendar: { cal })
        for minute in stride(from: 0, through: 59, by: 1) { monitor.tick(now: at(30, 1, minute)) }
        XCTAssertFalse(monitor.isShowing)
    }

    func testCopyIsOneQuietSentenceSet() {
        let m = RestNudgeLine.message
        XCTAssertFalse(m.contains("$"), "never carries a number")
        XCTAssertFalse(m.lowercased().contains("should"), "no guilt")
    }

    func testIdleReaderReturnsAReading() {
        // Smoke test against the real API: a finite, non-negative number.
        let idle = SystemIdle.secondsSinceLastInput()
        XCTAssertTrue(idle.isFinite && idle >= 0, "\(idle)")
    }
}
