// Theme.swift — switchable color palettes for the menu bar popover.
//
// Each theme defines six semantic colors that flow through every section
// of the UI. The user picks a theme in Settings; the selection persists
// via @AppStorage("appTheme").

import SwiftUI

// MARK: - Theme colors

/// Six semantic color roles used across the popover. Each AppTheme
/// provides its own instance so the entire UI recolors at once.
struct ThemeColors {
    let primary: Color    // hero gradient start, dominant tone
    let secondary: Color  // hero gradient middle, model bars, session dots
    let accent: Color     // bright accent, chart lines, interactive highlights
    let highlight: Color  // cost/monetary color (amber/gold family)
    let warm: Color       // warm gradient end, bar chart fill
    let tertiary: Color   // third stat card (streak / days)
}

// MARK: - Theme enum

enum AppTheme: String, CaseIterable, Identifiable {
    case twilight
    case ember
    case frost
    case onyx

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .twilight: return "Twilight"
        case .ember:    return "Ember"
        case .frost:    return "Frost"
        case .onyx:     return "Onyx"
        }
    }

    var colors: ThemeColors {
        switch self {
        case .twilight:
            return ThemeColors(
                primary:   Color(red: 0.263, green: 0.220, blue: 0.792),  // #4338ca
                secondary: Color(red: 0.427, green: 0.157, blue: 0.851),  // #6d28d9
                accent:    Color(red: 0.545, green: 0.361, blue: 0.965),  // #8b5cf6
                highlight: Color(red: 0.706, green: 0.325, blue: 0.035),  // #b45309
                warm:      Color(red: 0.961, green: 0.690, blue: 0.255),  // #f5b041
                tertiary:  Color(red: 0.059, green: 0.463, blue: 0.431)   // #0f766e
            )
        case .ember:
            return ThemeColors(
                primary:   Color(red: 0.604, green: 0.204, blue: 0.071),  // #9a3412
                secondary: Color(red: 0.760, green: 0.255, blue: 0.047),  // #c2410c
                accent:    Color(red: 0.918, green: 0.345, blue: 0.047),  // #ea580c
                highlight: Color(red: 0.851, green: 0.467, blue: 0.024),  // #d97706
                warm:      Color(red: 0.984, green: 0.749, blue: 0.141),  // #fbbf24
                tertiary:  Color(red: 0.020, green: 0.588, blue: 0.412)   // #059669
            )
        case .frost:
            return ThemeColors(
                primary:   Color(red: 0.118, green: 0.227, blue: 0.373),  // #1e3a5f
                secondary: Color(red: 0.145, green: 0.388, blue: 0.918),  // #2563eb
                accent:    Color(red: 0.376, green: 0.647, blue: 0.980),  // #60a5fa
                highlight: Color(red: 0.031, green: 0.569, blue: 0.698),  // #0891b2
                warm:      Color(red: 0.404, green: 0.910, blue: 0.976),  // #67e8f9
                tertiary:  Color(red: 0.486, green: 0.227, blue: 0.929)   // #7c3aed
            )
        case .onyx:
            return ThemeColors(
                primary:   Color(red: 0.122, green: 0.122, blue: 0.137),  // #1f1f23
                secondary: Color(red: 0.247, green: 0.247, blue: 0.275),  // #3f3f46
                accent:    Color(red: 0.443, green: 0.443, blue: 0.478),  // #71717a
                highlight: Color(red: 0.631, green: 0.631, blue: 0.667),  // #a1a1aa
                warm:      Color(red: 0.831, green: 0.831, blue: 0.847),  // #d4d4d8
                tertiary:  Color(red: 0.322, green: 0.322, blue: 0.357)   // #52525b
            )
        }
    }

    /// SF Symbol for the theme picker swatch.
    var icon: String {
        switch self {
        case .twilight: return "moon.stars.fill"
        case .ember:    return "flame.fill"
        case .frost:    return "snowflake"
        case .onyx:     return "circle.fill"
        }
    }
}
