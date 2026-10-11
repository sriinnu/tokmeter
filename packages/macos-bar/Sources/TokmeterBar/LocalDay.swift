// LocalDay.swift — "is this recorded day today?", answered one way.
//
// DailyUsage dates are local yyyy-MM-dd. The last recorded day is not
// necessarily today (a quiet day records nothing), and a key computed once
// goes stale at midnight in a menubar app that runs for weeks. So the
// formatter is cached and the date never is.

import Foundation

enum LocalDay {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar.current
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Today's local date as yyyy-MM-dd, computed on every call.
    static func todayKey(_ now: Date = Date()) -> String {
        formatter.timeZone = TimeZone.current
        return formatter.string(from: now)
    }

    static func isToday(_ key: String) -> Bool { key == todayKey() }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "2026-09-07" → "Sep 07, 2026". Every tooltip that names a day uses
    /// this, so one theme never mixes ISO and spelled-out dates. Anything
    /// that isn't yyyy-MM-dd comes back unchanged.
    static func pretty(_ iso: String) -> String {
        let parts = iso.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4,
              let month = Int(parts[1]), (1...12).contains(month),
              let day = Int(parts[2]) else { return iso }
        return "\(months[month - 1]) \(String(format: "%02d", day)), \(parts[0])"
    }
}
