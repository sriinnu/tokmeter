import SwiftUI

/// Dark surfaces keep the spectrum at their edges, clear of the data.
struct PrismPanel: View {
    let colors: ThemeColors
    var cornerRadius: CGFloat = 16

    private var rim: LinearGradient {
        LinearGradient(colors: [colors.secondary.opacity(0.72), colors.accent.opacity(0.18),
                                colors.warm.opacity(0.12), colors.accent.opacity(0.50)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(LinearGradient(colors: [Color(red: 0.085, green: 0.085, blue: 0.145),
                                          Color(red: 0.045, green: 0.05, blue: 0.09)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(rim, lineWidth: 0.8))
            .overlay(alignment: .top) {
                LinearGradient(colors: [.clear, colors.secondary.opacity(0.75), colors.accent.opacity(0.7), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(height: 1)
                    .padding(.horizontal, cornerRadius)
            }
    }
}

struct PrismHeroBackdrop: View {
    let colors: ThemeColors

    var body: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(colors: [Color(red: 0.08, green: 0.06, blue: 0.16),
                                    Color(red: 0.035, green: 0.055, blue: 0.10)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            GeometryReader { geometry in
                let w = geometry.size.width
                let h = geometry.size.height
                Path { path in
                    path.move(to: CGPoint(x: w * 0.57, y: -h * 0.2))
                    path.addLine(to: CGPoint(x: w * 0.88, y: h * 0.53))
                    path.addLine(to: CGPoint(x: w * 0.62, y: h * 1.3))
                    path.closeSubpath()
                }
                .fill(LinearGradient(colors: [colors.secondary.opacity(0.10), colors.accent.opacity(0.025)],
                                     startPoint: .top, endPoint: .bottom))
                Path { path in
                    path.move(to: CGPoint(x: w * 0.57, y: -h * 0.2))
                    path.addLine(to: CGPoint(x: w * 0.88, y: h * 0.53))
                    path.addLine(to: CGPoint(x: w * 0.62, y: h * 1.3))
                    path.move(to: CGPoint(x: w * 0.88, y: h * 0.53))
                    path.addLine(to: CGPoint(x: w * 1.1, y: h * 0.38))
                }
                .stroke(LinearGradient(colors: [colors.secondary.opacity(0.4), colors.accent.opacity(0.28), .clear],
                                       startPoint: .top, endPoint: .bottom), lineWidth: 0.8)
            }
            LinearGradient(colors: [colors.secondary, colors.warm, colors.accent],
                           startPoint: .leading, endPoint: .trailing)
                .frame(height: 2)
        }
        .allowsHitTesting(false)
    }
}
