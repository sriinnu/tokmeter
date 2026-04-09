// swift-tools-version:5.9
//
// TokmeterBar — macOS menubar companion for Drishti.
//
// Build:
//   swift build -c release
//
// Bundle as a real .app:
//   ./bundle.sh
//
// The resulting binary connects to the Drishti daemon's HTTP REST API on
// localhost:9877. The daemon must be running:
//   drishti daemon start

import PackageDescription

let package = Package(
    name: "TokmeterBar",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "TokmeterBar", targets: ["TokmeterBar"]),
    ],
    targets: [
        .executableTarget(
            name: "TokmeterBar",
            path: "Sources/TokmeterBar"
        ),
    ]
)
