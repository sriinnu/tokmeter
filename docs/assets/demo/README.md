# Synthetic-data walkthrough

`tokmeter-demo.mp4` is a 20-second walkthrough rendered from the production SwiftUI `HeroHeader` and `UsageOverview` views. It is not a screen recording of a live customer session.

The four scenes show an idle day, normal usage, a missing price, and tool-reported cost. The amounts and projects are synthetic; the generator reads no local session files or credentials. The scene captions and demo footer are presentation overlays in the renderer, not controls in the app.

Reproduce from the repository root on macOS with Xcode, Bun, and FFmpeg:

```sh
bun scripts/generate-demo.ts
bunx biome format --write docs/assets/demo/snapshots.json
TOKMETER_DEMO_DIR="$PWD/docs/assets/demo" swift test --package-path packages/macos-bar --filter DemoRenderTests
ffmpeg -y -framerate 1/5 -i docs/assets/demo/scene-%02d.png -c:v libx264 -r 24 -pix_fmt yuv420p -movflags +faststart docs/assets/demo/tokmeter-demo.mp4
```

Inspect every PNG for clipped text and missing controls before replacing the public assets. Rendering must use the same production views as the app; do not retouch a screenshot to imply functionality that the build does not have.
