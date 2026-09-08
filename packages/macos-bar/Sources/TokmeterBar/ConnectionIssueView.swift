import AppKit
import SwiftUI

struct ConnectionIssueView: View {
    let error: String
    let needsNodeSetup: Bool
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "bolt.trianglebadge.exclamationmark.fill")
                    .foregroundColor(.orange)
                    .font(.system(size: 12))
                Text(error)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundColor(.primary.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                if needsNodeSetup {
                    Button("Install Node.js") {
                        NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
                    }
                }
                Button("Retry", action: retry).disabled(isRetrying)
            }
            .font(.system(size: 11, weight: .medium))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.12)))
        .accessibilityElement(children: .contain)
    }
}
