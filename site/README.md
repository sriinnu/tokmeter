# tokmeter.srinivas.dev

The project site: a landing page and the user docs, built with Astro and
served by Cloudflare Pages.

## Pages come from the docs

`src/content/` is generated. Don't edit it; edit the source and re-sync:

| Page | Source |
| --- | --- |
| install, cli, daemon, faq | the GitHub wiki (a separate repo) |
| menu-bar, mcp, numbers, backup, troubleshooting, architecture | `docs/` in this repo |

```sh
git clone https://github.com/sriinnu/tokmeter.wiki.git /tmp/tokmeter.wiki
cd site
npm run sync -- /tmp/tokmeter.wiki
```

The version in the hero is read from `packages/tokmeter/package.json` at
build time, so a release updates it on the next deploy.

## Theme images

`public/images/theme-*.jpg` are the app's own renders of synthetic demo data,
never a real usage screenshot:

```sh
cd packages/macos-bar
TOKMETER_UI_QA_DIR=/tmp/qa swift test --filter DemoRenderTests/testRenderThemeReview
# then convert /tmp/qa/<theme>-collapsed.png to site/public/images/theme-<theme>.jpg
```

## Develop and deploy

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
```

Cloudflare Pages: root directory `site`, build command `npm run build`,
output directory `dist`, Node 22 (`.node-version`).
