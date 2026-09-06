#!/usr/bin/env python3
"""Attach license texts and local build source to distributable artifacts."""

import argparse
import shutil
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def source_files():
    # Explicit source/build inputs only: never sweep the working directory,
    # credentials, local usage, personal notes, or generated build trees.
    files = set()
    for name in ("LICENSE", "README.md", "CHANGELOG.md", "package.json", "bun.lock",
                 "tsconfig.base.json", "biome.json", "vitest.config.ts",
                 "docs/licensing.md"):
        path = ROOT / name
        if path.is_file():
            files.add(path)
    for path in (ROOT / "scripts").iterdir():
        if path.suffix in (".sh", ".ts", ".py"):
            files.add(path)
    for package in (ROOT / "packages").iterdir():
        if not package.is_dir():
            continue
        for directory in ("src", "Sources", "Tests", "scripts"):
            base = package / directory
            if base.exists():
                for path in base.rglob("*"):
                    if path.is_file() and path.suffix in (
                        ".ts", ".tsx", ".swift", ".json", ".css", ".html", ".svg", ".sh", ".py"
                    ):
                        files.add(path)
        for pattern in ("package.json", "tsconfig*.json", "vite.config.*", "index.html",
                        "LICENSE", "README.md", "Package.swift", "Package.resolved",
                        "*.sh", "entitlements.plist", "AppIcon.icns"):
            files.update(path for path in package.glob(pattern) if path.is_file())
    for path in sorted(files):
        if path.is_symlink():
            raise RuntimeError(f"Source input must not be a symlink: {path.relative_to(ROOT)}")
        yield path


def prepare(destination, sparkle_license=None):
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "LICENSE", destination / "AGPL-3.0-only.txt")
    shutil.copyfile(ROOT / "packages/core/LICENSE", destination / "MPL-2.0.txt")
    shutil.copyfile(ROOT / "docs/licensing.md", destination / "README.md")
    if sparkle_license is not None:
        if not sparkle_license.is_file():
            raise RuntimeError("The bundled Sparkle artifact must supply its LICENSE")
        shutil.copyfile(sparkle_license, destination / "Sparkle.txt")
    with tarfile.open(destination / "tokmeter-source.tar.gz", "w:gz") as archive:
        for path in source_files():
            archive.add(path, arcname=Path("tokmeter-source") / path.relative_to(ROOT), recursive=False)
    print(f"License texts and source prepared: {destination.relative_to(ROOT) if destination.is_relative_to(ROOT) else destination}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("npm", "macos"))
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    if args.mode == "npm":
        for package in ("tokmeter", "mcp"):
            dist = ROOT / "packages" / package / "dist"
            if not dist.is_dir():
                raise RuntimeError(f"Build {package} before preparing its licenses")
            prepare(dist / "licenses")
    else:
        if args.destination is None:
            parser.error("macos requires --destination")
        prepare(args.destination.resolve(), ROOT / "packages/macos-bar/.build/artifacts/sparkle/Sparkle/LICENSE")
