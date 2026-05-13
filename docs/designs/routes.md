# Design: `tokmeter routes` — cost surface explorer

> Status: **Proposed** · Owner: tokmeter core · Date: 2026-05-13

A provider-agnostic, kosha-driven view that answers one question for any
parsed session, branch, or project: **across every model and serving
route available today, what would this same workload cost?** The matrix
is the feature. Tokmeter does not recommend; it surfaces. The user picks.

---

## 1. Why this exists

Every other token tracker we've surveyed either (a) only knows its own
provider's catalog, or (b) silently picks a "cheaper alternative" by
hardcoding a list of models that goes stale within a release. Tokmeter
is the only tool positioned to be neutral because the layer underneath
it — kosha-discovery — is already neutral: 20+ providers, daily
refresh, no implicit defaults, no editorial.

The question users ask out loud right now is some variant of *"could I
have done this for less, on the same task, without a quality cliff?"*
Tokmeter cannot answer the **quality** half — we'll come back to that —
but the **cost-given-this-workload** half is purely a kosha join and is
sitting on the table.

The unanswered question, precisely: for a unit of work tokmeter already
has data on, what is the full cost surface across (model × serving
route) pairs available **today**?

---

## 2. Goals

- Given a `session-id`, `branch`, or `project`, produce a sorted matrix
  of (model × serving-provider) tuples and the projected cost of the
  same token volume on each.
- The matrix is sourced live from kosha at query time. No hardcoded
  model list anywhere in tokmeter (code, docs, screenshots, examples).
- The "actual run" column reflects historical, frozen pricing — the
  number the user actually paid. The "alternatives" columns reflect
  today's kosha snapshot. Both timestamps must be visible.
- Cache economics are modeled per-provider where they differ
  materially. Where they cannot be modeled honestly, the assumption is
  stated inline.
- Surface available across CLI, TUI, web dashboard, macOS bar, and
  drishti MCP (Claude can call it mid-session).
- Works for every agent tokmeter parses today (16) and every provider
  kosha exposes today (20+). New parsers and new providers light up
  with no code changes here.

## 3. Non-goals (explicit)

- **No quality claims.** We do not say "Sonnet would have produced the
  same result." We do not show success rates. We do not have ground
  truth for outcomes and we will not fabricate one.
- **No `Recommended` badge.** No `Best value` highlight. No implicit
  default in the sort order beyond an honest neutral metric (cost
  ascending, or user's chosen sort).
- **No live routing**, no API-key brokering, no request rewriting. We
  are not in the request path. We surface what spend would have been.
- **No turn-count predictions for models the user has never tried.**
  See §6.3 — turn efficiency is descriptive of observed data only.
- **No hardcoded fallbacks** when kosha is unavailable. If kosha
  cannot answer, the matrix surfaces the daemon's last-known good
  snapshot with its timestamp, or refuses cleanly. It never invents.

---

## 4. The unit of comparison

The matrix axis is not "model." It is **(model × serving-provider)**.

The same model identifier can be served by multiple routes at different
prices: `claude-sonnet-4-X` via Anthropic direct, via Bedrock, via
Vertex, via OpenRouter. Kosha already tracks this distinction through
its `originPricing` (direct-from-creator rate) and `pricing` (the
serving layer's billed rate) fields — see
`packages/core/src/pricing.ts:74` for the existing resolver.

The matrix must expose both axes:

- **Origin** — who created the model (Anthropic, OpenAI, Google, Meta,
  DeepSeek, Alibaba, Moonshot, xAI, …)
- **Serving route** — who's billing for the inference (the origin
  itself; or AWS Bedrock, GCP Vertex, OpenRouter, Together, Fireworks,
  Groq, …)

Default view sorts by total cost ascending. Optional grouping by
origin, by serving route, or by capability tier. The user picks the
slice.

---

## 5. Data flow

```
JSONL files (~/.claude/projects, ~/.codex, ~/.cursor, ...)
    │
    │  existing parsers (16 providers)
    ▼
TokenRecord[]                       ──┐
  { timestamp, model, provider,        │
    inputTokens, outputTokens,         │  already exists today
    cacheReadTokens, cacheWriteTokens, │
    reasoningTokens, cost (frozen),    │
    project, cwd, kind }               │
                                      ──┘
    │
    │  new: route projector  (this design)
    ▼
RouteMatrix                          ──┐
  rows: KoshaModel[] (live query)      │
  cols: (origin × serving) tuples      │  new in this design
  cells: projected $, derivation flags │
                                      ──┘
    │
    ▼
Surfaces (CLI, TUI, web, bar, MCP)
```

The TokenRecord shape (see `packages/core/src/types.ts:24`) already
separates the five token classes we need: input, output, cache read,
cache write, reasoning. Nothing in the existing record has to change.
The projector is a pure function over (records, koshaSnapshot,
cacheModel) → matrix.

---

## 6. The math

Three layers of progressively-more-aggressive claims. The defaults stay
in the bottom layer; the others are opt-in.

### 6.1 Layer 1 — pure pricing translation (default, always honest)

For each candidate `(model, serving)` in kosha:

```
projectedCost =
    inputTokens          × inputPerMillion(model, serving)        / 1e6
  + outputTokens         × outputPerMillion(model, serving)       / 1e6
  + cacheReadTokens      × cacheReadPerMillion(model, serving)    / 1e6
  + cacheWriteTokens     × cacheWritePerMillion(model, serving)   / 1e6
  + reasoningTokens      × reasoningPerMillion(model, serving)    / 1e6
```

This is **a pure repricing**: same observed token volumes, applied to
the alternative route's per-million rates. It makes no claim about
whether the alternative model would have generated the same volumes.

Behavior when a route doesn't price one of the five token classes
(common — many providers have no separate cache-read or reasoning
rate): the term is computed at the input rate, and the cell is flagged
`assumed: cacheTokensPricedAsInput` or similar so the user knows the
assumption. This keeps the cell honest rather than dropping the route
from the matrix.

This layer alone is enough to ship the feature. Everything below is
layered on as the cache and behavioral models mature.

### 6.2 Layer 1.5 — cache-economics adjustment (opt-in, per-provider)

Sticker prices lie when cache mechanics differ. The same workload
plays through providers very differently:

| Provider     | Cache mechanism                                       | TTL     | Write multiplier | Read multiplier |
|--------------|-------------------------------------------------------|---------|------------------|-----------------|
| Anthropic    | Explicit `cache_control` blocks, opt-in per request   | 5 min   | 1.25× input      | 0.10× input     |
| OpenAI       | Automatic prefix cache, no opt-in                     | ~10 min | n/a (free write) | 0.50× input     |
| Gemini       | Implicit context caching                              | varies  | n/a              | implicit (free) |
| DeepSeek     | Explicit context cache, separately priced             | varies  | dedicated rate   | dedicated rate  |
| Bedrock/Vertex| Inherit origin's cache model, may add platform fees  | inherit | inherit          | inherit         |

(Numbers are illustrative of mechanic shape, not committed truth —
the actual multipliers and TTLs live in kosha. Verify each before
shipping the cache-economics layer.)

Three strategies for repricing cache traffic on an alternative route:

1. **Assume cache rate equals observed rate.** Apply the alternative's
   cache-read multiplier to `cacheReadTokens`. Honest about the
   assumption, dishonest about reality (a 5-min TTL provider may have
   churned the cache when a 10-min TTL provider wouldn't have).
   *Default for v1.* Cell flagged `cacheRate: observed`.

2. **Simulate per-provider cache eligibility from JSONL timing.**
   Walk the session's turn timestamps; for each request, replay the
   target provider's TTL and write rules to decide whether each block
   would have been a hit. More honest, much more code, requires per-
   provider behavioral specs in kosha or alongside it. *v2.*

3. **Show both bounds.** Cheapest-case (every reuse hits cache) and
   worst-case (no cache benefit) for each route. Visually noisier,
   maximally honest. *Optional toggle.*

Recommendation: ship (1) first, gate (2) and (3) on user demand. Flag
the cell so the user knows what's modeled.

### 6.3 Layer 2 — observed turn efficiency (descriptive only)

Cost-per-token is one axis. Cost-per-actual-completion is another.
Without a quality signal we cannot project the latter for models the
user has never used. We can, however, **report** it from data the
user already has.

For each `(workload signature, model)` pair where the user has
≥`MIN_OBSERVATIONS` sessions (proposed default: 5), surface the
observed median:

- turns-per-session
- output-tokens-per-session
- cache-hit-ratio-per-session
- $-per-session

A **workload signature** is a tuple over cheap, available signals:

- repo path (or project)
- distribution of file extensions read/edited (top-3 buckets)
- distribution of tool calls (Edit-heavy / Read-heavy / Bash-heavy /
  mixed — bucketed, not raw)
- approximate session length bucket (short / medium / long by turn
  count, not duration)

Workload-signature clustering is a separate, opt-in surface. When the
user opens `tokmeter routes <session>` and they have multi-model
history on this kind of work, the matrix grows a sidebar:

> In this repo, when you used `<model-A>` on Edit-heavy sessions you
> averaged 3.8 turns; when you used `<model-B>` on the same signature
> you averaged 6.2. (Median over 8 sessions A, 5 sessions B.)

That is descriptive. The matrix does not multiply the per-token
counterfactual by the observed turn ratio to "estimate" what
`<model-A>` would have cost on a `<model-B>` session, because that
collapses two unrelated things and presents a single fictional number.

### 6.4 What we never compute

- "Model X would have succeeded where Model Y did not."
- "Model X is recommended for this workload."
- "Switch to Model X and save $N." — even when the math says yes, we
  do not predict success. We show $; we do not prescribe.

These restrictions are load-bearing for the feature's credibility. The
moment tokmeter recommends, it joins the pile of biased trackers. It
must not.

---

## 7. Two time bases

Tokmeter already enforces "historical records frozen — past cost rows
are immutable; only today reprices on kosha updates." This feature
must extend that discipline, not violate it.

| Column                | Pricing as of                | Catalog as of |
|-----------------------|------------------------------|---------------|
| Your actual run       | Run timestamp (frozen)       | Whatever route the agent actually used |
| Alternatives matrix   | **Today** (kosha snapshot)   | **Today** (kosha snapshot) |

Both timestamps must be visible at the top of every surface:

> Actual run: $4.20, priced 2026-05-12 (Anthropic direct).
> Alternatives priced from kosha snapshot 2026-05-13 17:04 UTC
> (N=42 models across M=11 serving routes).

If a model that appears in the user's actual run column has been
deprecated by today's snapshot, the actual row remains intact (frozen)
and a marker is appended: "deprecated 2026-04-21." The alternatives
matrix does not include the deprecated route.

If a model exists today that did not exist when the session ran, it
appears in alternatives without comment. The point of the alternatives
column is *today's lineup against historical token volumes*, not
*what was available then*.

---

## 8. Surfaces & phasing

### Phase 0 — kernel (no UI)

- New module: `packages/core/src/routes.ts`
- Exports `projectRoutes(records, koshaSnapshot, opts): RouteMatrix`
- Pure function, fully unit-testable
- Snapshot type captured from `@sriinnu/kosha-discovery`'s registry
  exports; we do not freeze our own copy
- Tests cover: layer-1 math, missing-rate fallback flagging, time-base
  separation, multi-model session aggregation

### Phase 1 — CLI

```
tokmeter routes <selector>
  selector:
    --session <id>
    --branch <name>       (requires git PR/branch attribution; see §13)
    --project <name>
    --today               (shortcut: all today's sessions)
    --range <from..to>

  output:
    --format table|json|csv     (default table)
    --sort cost|model|provider  (default cost)
    --limit N                   (default 20)
    --group-by origin|serving|none
    --efficiency observed       (opt in to layer 2 sidebar)
```

JSON output is the source-of-truth shape. Table is rendered from JSON.
This keeps the MCP tool and the surfaces consistent.

### Phase 2 — TUI

Interactive matrix. Sortable columns. Drill-down into a single route
shows the per-token-class breakdown (input contributes $X, cache read
contributes $Y, etc.) so the user can see where the cost actually
lives.

### Phase 3 — Web

Full table view + a cost histogram + an origin-vs-serving heatmap.
Plotly already in the stack.

### Phase 4 — macOS bar

Condensed: in the project drilldown view, a single line below the
existing cost number: "today's cheapest route across kosha: $X
(N alternatives within 2× of actual)." Tap-through opens the full
matrix in the hub window.

### Phase 5 — drishti MCP tool

Single tool: `tokmeter_route_matrix(scope: session|branch|project|today, …)`
Returns the same JSON the CLI returns. Lets Claude (or any MCP client)
query the matrix mid-session — but tokmeter does not push it. Claude
asks if Claude wants to know.

---

## 9. Edge cases

- **Model in actual run was deprecated today.** Actual row stays
  (frozen). Alternatives use today's lineup.
- **Model in actual run is gone from kosha entirely** (not just
  deprecated — removed). Actual row stays with a "kosha no longer
  recognizes this model" annotation; alternatives still rendered.
- **New model in today's snapshot didn't exist at run time.** Appears
  in alternatives without commentary. The matrix is "what could it
  cost today," not "what could it have cost then."
- **Provider down / kosha health degraded.** Matrix shows the
  last-known-good snapshot with its age. If snapshot age exceeds a
  threshold (proposed: 7 days), the surface refuses with a clear
  message rather than rendering stale data silently.
- **User pricing override present.** Override applies before kosha
  data for that model. Cell flagged `override: user` so the source is
  visible. Existing `pricing-overrides.json` shape is already
  documented at `packages/core/src/pricing.ts:19`.
- **Multi-model session.** Session aggregates token volumes per model;
  the matrix projects total cost across all alternative routes
  applied to each model's volume independently, then summed. This is
  the same shape ccusage and tokmeter already use for cost.
- **Cross-agent branch / project.** When `--branch` or `--project`
  spans sessions from multiple agents (Claude Code + Cursor on the
  same branch, etc.), token volumes are summed across all source
  agents before projection. The matrix doesn't care which agent
  generated the tokens — only kosha's pricing shape per route.
- **Free / negotiated routes.** A user-override of `inputPerMillion:
  0` produces a $0 cell. Sorting by cost puts it first. This is
  correct behavior — if the user has a free internal deployment, that
  *is* the cheapest route. The override flag makes the source
  visible.

---

## 10. Privacy & local-first

Every step happens locally:

- JSONL parsing — already local.
- Kosha registry — already local-first (`~/.kosha/registry.json`),
  refreshed by the daemon's cron.
- Projection math — pure local computation.
- No outbound network for the matrix itself. No telemetry, no upload,
  no "anonymous comparison cohort" — see §13 if we ever revisit.

The MCP tool (Phase 5) hands data to a local MCP client. The client
may itself be a network-bound agent (Claude Code calling out to
Anthropic), but tokmeter neither initiates nor mediates that traffic.

---

## 11. Open questions / risks

1. **Cache-economics modeling depth (§6.2).** Layer 1.5 strategy (1)
   is honest about its limitations but understates reality for the
   user trying to make a real decision. Strategy (2) is much more
   useful but requires per-provider behavioral specs that don't exist
   today. Where does this live — in kosha, alongside tokmeter, or as
   a separate package? **Open.**

2. **Workload signature for §6.3.** "Edit-heavy / Read-heavy /
   Bash-heavy / mixed" is a starting cut, not a finished taxonomy.
   What's the right granularity that's stable enough to cluster and
   sharp enough to be useful? Validate empirically against actual
   user data before locking in. **Open.**

3. **MIN_OBSERVATIONS threshold** for surfacing observed turn
   efficiency. Too low and we surface noise; too high and only the
   heaviest users ever see the feature. Proposed default 5; revisit
   after a month of dogfooding.

4. **Cross-agent branch attribution** assumes a clean mapping from
   session timestamps to git commit/branch windows. Sessions can
   span branch switches; commits can land hours after the session
   that produced them. The PR-attribution work (a separate design)
   has to land before `--branch` is meaningful. Phase 1 supports
   `--session` and `--project` only; `--branch` waits for that
   prerequisite.

5. **Sort defaults are an editorial choice.** Cost-ascending puts
   the cheapest first, which reads as a recommendation even when we
   intend it as a sort. Alternative: alphabetical by origin, with
   the actual-run row pinned. Defer to a usability cut after the
   first surface ships.

6. **Reasoning-token repricing.** Reasoning rates vary wildly and
   are sparsely populated in kosha. When unknown, fall back to
   `outputPerMillion` (current convention). Flag the cell. Revisit
   once kosha's coverage improves.

---

## 12. Boundaries with related features

This design names other features tokmeter intends to build but does
not specify them. Each composes cleanly with routes:

- **PR / branch cost attribution.** Joins git timestamps with JSONL
  session windows to produce per-branch and per-PR totals. Required
  for `tokmeter routes --branch` to mean anything. Separate design.
- **Waste-tax surface.** Detects redundant reads, cache-miss tax,
  compaction-triggered-by-junk. Lives in the daemon and the bar.
  Compatible with routes but orthogonal — routes asks "what would
  the same work cost elsewhere"; waste-tax asks "what could the work
  have been smaller."
- **Audit-rules.** Cross-agent rules-file analysis (CLAUDE.md /
  AGENTS.md / .cursorrules / .codexrules). Smallest-scope sleeper
  feature. Independent of routes.
- **Budgets / forecasting.** Caps and projections at daemon level.
  Independent of routes; could consume the routes projection to
  answer "would I still hit my cap on the cheapest route?" later.

These are sketched here only to confirm the routes design doesn't
preclude them. Each gets its own document before it ships.

---

## 13. Things explicitly deferred

- Anonymized comparison cohorts ("developers on similar workloads
  spend $X on average") would require a telemetry channel that
  tokmeter does not have and does not want. Out of scope.
- Live routing recommendations during a session would require sitting
  in the request path. Tokmeter is post-hoc by design. Out of scope.
- A "should I switch" prescriptive surface. Repeated under non-goals
  because it's the easiest mistake to make later.

---

## 14. Acceptance criteria for v1

The feature ships when:

- `tokmeter routes --session <id>` returns a sorted matrix of every
  active route in kosha, with the actual run row pinned, both time
  bases visible, and per-cell flags for assumptions.
- `tokmeter routes --project <name>` aggregates across all sessions
  in that project, multi-agent included, and returns the same matrix
  shape.
- Output is identical (modulo formatting) across CLI table, CLI JSON,
  and the drishti MCP tool.
- No model identifier is hardcoded anywhere in the implementation;
  every name comes from kosha at query time.
- No "Recommended" / "Best value" / "Switch to X" string appears in
  any surface.
- A user with a pricing override sees their override applied and
  flagged.
- A session whose model was deprecated since the run still renders
  cleanly with the actual row intact and an annotation.

The feature does *not* require:

- Cache-economics layer 1.5 strategy (2) or (3). Strategy (1) is
  enough for v1 with the cell flag.
- Observed turn efficiency (§6.3). Layer 2 is a separate phase.
- TUI / web / bar surfaces. CLI + MCP is enough.

---

## 15. Appendix — kosha touch points

For implementers picking up this doc:

- `@sriinnu/kosha-discovery` registry is consumed today at
  `packages/core/src/pricing.ts`. Resolution chain (cache → overrides
  → kosha direct → kosha fuzzy → manifest → null) is already in
  place and is the right primitive to reuse — see `pickUsablePricing`
  (`packages/core/src/pricing.ts:74`) for origin-vs-serving handling.
- Kosha CLI exposes `list`, `roles`, `model`, `capable`, `cheapest`
  (run `kosha --help`). Programmatic access via the JS package is
  preferred; CLI is fine for debugging.
- `~/.kosha/registry.json` mtime is already tracked by the daemon
  (see `/api/pricing-status` in drishti). Routes should hook into
  the same freshness signal rather than maintaining its own.
- `KOSHA_SCHEMA_VERSION` in `pricing.ts:71` is the manifest schema
  pin. If the routes projector reads the manifest directly, gate it
  on the same version.
