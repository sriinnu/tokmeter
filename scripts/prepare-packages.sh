#!/usr/bin/env bash
# Create reviewable npm artifacts without publishing. Run bun run build first.
set -euo pipefail
cd "$(dirname "$0")/.."
candidate_dir="${1:-/tmp/tokmeter-candidate}"
mkdir -p "$candidate_dir"
candidate_dir="$(cd "$candidate_dir" && pwd)"
python3 scripts/prepare-license-materials.py npm
for package in tokmeter mcp; do
    version="$(node -p "require('./packages/$package/package.json').version")"
    artifact="$candidate_dir/$package-$version.tgz"
    [[ -d "packages/$package/dist" ]] || { echo "Missing build for $package" >&2; exit 1; }
    (cd "packages/$package" && bun pm pack --filename "$artifact" --ignore-scripts --quiet)
    # Bun resolves workspace:* to the actual release version. Verify that the
    # tarball is installable by npm before a release can publish it.
    tar -xOf "$artifact" package/package.json | node -e '
      let input="";
      process.stdin.on("data",d=>input+=d).on("end",()=>{
        const p=JSON.parse(input);
        for(const section of ["dependencies","optionalDependencies","peerDependencies"])
          for(const [name,version] of Object.entries(p[section]??{}))
            if(version.startsWith("workspace:")) throw new Error(`Unresolved workspace dependency: ${name}`);
        if(p.name === "@sriinnu/drishti" && p.dependencies?.["@sriinnu/tokmeter"] !== p.version)
          throw new Error("Drishti must depend on the exact paired Tokmeter release");
        console.log(`Verified ${p.name}@${p.version}`);
      });'
done
