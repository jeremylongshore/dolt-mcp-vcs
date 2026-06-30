# Architecture blueprint — `dolt-mcp-vcs`: one version-control core + thin adapters

| | |
|---|---|
| **Doc** | 002-AT-ARCH-dolt-mcp-vcs-blueprint |
| **Category** | AT — Architecture & Technical · ARCH — architecture blueprint |
| **Status** | Blueprint — the build spec for the `beads-dolt` → `dolt-mcp-vcs` inversion |
| **Author** | Jeremy Longshore \<jeremy@intentsolutions.io\> |
| **Date** | 2026-06-29 |
| **Decides-on** | doc 001 (product-family research) |
| **Governed-by** | doc 003 (decision record — the inversion + canon dissent + overrides) |
| **Proposed identity** | plugin/slug + MCP-server id = **`dolt-mcp-vcs`** (pending greenlight; see doc 003 §rename) |

---

## 0. Thesis

`beads-dolt` is, today, a **beads-first** plugin: a skill + 5 agents + a wired `dolt-mcp` server that
helps the `beads` task-tracker's Dolt backend, wiring 2 of `dolt-mcp`'s ~40 tools to its agents
(`query`, `list_databases`; `list_dolt_commits` is prose-only — see doc 001 §2.1). This blueprint
inverts it into a **Dolt-first platform plugin** where **beads is one use-case adapter**, covering the
whole 2026 DoltHub product family.

The decomposition — the one idea everything else hangs off (Rich Hickey's contribution, doc 003) — is:

> **One dialect-invariant version-control surface + thin adapters.** NOT four product silos. Flavor
> (MySQL / Postgres / SQLite / Mongo) and **maturity** (GA / beta / alpha / experimental) are *fields
> on a connection-descriptor value*, not top-level structure. "Full platform" is built as **core + N
> adapters**, so the 4th flavor is cheap, not a 4× copy.

Two non-negotiable cross-cutting rules sit on top of that core:

- **§5 Mutation verb taxonomy** (Kleppmann) — destructive ops are *structurally unreachable* from
  every agent's tool grant, not merely discouraged.
- **§7 The `dolt-watch` routine** — a radar that turns upstream Dolt advancement into action items and
  keeps each adapter's maturity gate honest. This is what makes "full platform incl. alpha" sustainable
  rather than vaporware.

---

## 1. Target architecture (one core + adapters)

```
dolt-mcp-vcs (plugin)
│
├─ CORE — the version-control-surface skill
│     branch / merge / diff / log / AS OF / commit / data-PR,
│     answered by querying the LIVE dolt-mcp / dolt CLI.
│     Keeps the repo's anti-snapshot discipline: introspect schema + read --help live;
│     never bake a frozen product/tool table into prose.
│
├─ CONNECTION DESCRIPTOR — a value, not env-literals
│     { flavor: dolt|doltgres|doltlite|dumbo,
│       endpoint, database, creds-ref, maturity }
│     Replaces the hardcoded `--dolt … --database beads` literals in .mcp.json.
│
├─ FLAVOR ADAPTERS — thin; maturity-gated
│     dolt/MySQL     = GA
│     doltgres/PG    = GA
│     doltlite/SQLite= alpha          ┐ core reads `maturity` and gates:
│     dumbo/Mongo    = experimental   ┘ experimental/alpha ⇒ WARN + read/safe-write only
│
├─ USE-CASE ADAPTERS
│     beads = adapter #1  — a named schema profile: the parent-child/epic encoding
│             + closure/bottleneck query templates, lifted OUT of the generic agents.
│
└─ AGENTS — 3, by capability (beads-ness quarantined in the adapter)
      • dolt-operator       sync/remotes/push + server-sprawl/recovery
      • dolt-query-analyst  SQL-via-MCP graph/audit (schema map is INPUT)
      • beads-adapter       the one place bd-sync / three-layer-mirror / bead schema lives
```

The core is **dialect-invariant**: it speaks `branch / merge / diff / log / AS OF / commit / data-PR`
and never hardcodes which flavor it is talking to. Everything flavor-specific is in the descriptor.

---

## 2. The connection descriptor (the value)

The descriptor's genuinely new contribution is making **`flavor` and `maturity` first-class data
fields that drive the §3 maturity gate** — the core reads `descriptor.maturity` to gate writes and
`descriptor.flavor` to select the wire dialect. It is *not* "de-hardcoding the endpoint/db literals"
or "hardening `DOLT_PASSWORD`": the repo's `.mcp.json` **already** parameterizes host/port/user/
database via `${VAR:-default}` substitution, and `DOLT_PASSWORD` is **already** a `${DOLT_PASSWORD:-}`
reference (shipped in commit `d8b79ab`). Endpoint/database/creds parameterization is therefore *not*
the value here — `flavor`+`maturity`-as-data is.

> **Reframing provenance:** the original "de-hardcodes literals / hardens `DOLT_PASSWORD`" framing
> was a strawman — Thompson + security-auditor flagged it in the engineering panel (doc 004,
> §3 MAJORS), because the parameterization it claimed as new already ships. This section now claims
> only what is genuinely new: `flavor`+`maturity` as gate-driving data.

It is a *value* the core and agents read.

```jsonc
// connection descriptor — flavor + maturity as gate-driving data
{
  "flavor":    "dolt",          // dolt | doltgres | doltlite | dumbo  — selects the wire dialect
  "endpoint":  "127.0.0.1:3308",// host:port, a Hosted-Dolt URL, a DoltLab host, … (already ${VAR:-default} in .mcp.json)
  "database":  "beads",         // the named database on the server (already ${VAR:-default} in .mcp.json)
  "creds-ref": "env:DOLT_PASSWORD", // a REFERENCE to a secret, never the secret itself (already ${DOLT_PASSWORD:-} today)
  "maturity":  "ga"             // ga | beta | alpha | experimental — read by the core to gate writes (kept current by dolt-watch)
}
```

Design rules:

1. **`flavor` selects the wire protocol/dialect**, nothing more. The core's VC verbs are identical
   across flavors; only the adapter knows that `dolt` ⇒ MySQL flags and `doltgres` ⇒ `--doltgres`.
2. **`maturity` is read by the core to gate writes** (§3). It is *data on the value*, not a code path
   per product — adding a flavor is adding a descriptor + a thin adapter, not a new silo. Together
   with `flavor`, this is the descriptor's **new** contribution; everything else below already ships.
3. **`creds-ref` is a pointer** (`env:NAME`, a SOPS key path) — the descriptor never carries a
   plaintext secret. This is **not new**: `.mcp.json` already passes `DOLT_PASSWORD` as a
   `${DOLT_PASSWORD:-}` reference (commit `d8b79ab`), so creds-as-reference is the status quo, not a
   hardening the descriptor introduces. The descriptor keeps it a reference; its new job is making
   `flavor`+`maturity` first-class.
4. The `.mcp.json` server entry's `endpoint`/`database` are **already** `${VAR:-default}`-parameterized
   today (commit `d8b79ab`) — the descriptor does not introduce that. What the descriptor **adds** is
   `flavor` (dialect selection) and `maturity` (the §3 write gate) as named data the core reads.

---

## 3. Flavor adapters (thin, maturity-gated)

Each flavor adapter is **thin** — it maps the descriptor's `flavor` to the right `dolt-mcp` connection
flags and declares its default maturity. It adds **no** new version-control semantics.

| Adapter | `flavor` | dolt-mcp connect | Default maturity | Write posture (until `dolt-watch` bumps it) |
|---|---|---|---|---|
| MySQL | `dolt` | `--dolt` + host/port/user/db | **ga** | full taxonomy (§5) |
| Postgres | `doltgres` | `--doltgres` + … | **ga** | full taxonomy (§5) |
| SQLite | `doltlite` | embeddable / file endpoint | **alpha** | **WARN + read/safe-write only** |
| Mongo | `dumbo` | FerretDB endpoint | **experimental** | **WARN + read/safe-write only** |

**The maturity gate is enforced in the core, not per-adapter:** the core reads
`descriptor.maturity`, and for `alpha`/`experimental` it (a) emits a visible WARN that the surface is
pre-GA and (b) refuses to even *recommend* history-affecting ops, restricting the agent to read +
safe-write. This is the honesty mechanism — an alpha adapter cannot pretend to be production.

---

## 4. Use-case adapters — beads as adapter #1

Beads stops being the *subject* of the plugin and becomes its **first use-case adapter**: a named
**schema profile** plus query templates, lifted out of the generic agents.

The beads profile carries:

- **Schema encoding** — `type='parent-child'` (epic membership; `issue_id`=child,
  `depends_on_id`=epic parent), `type='blocks'` (scheduling; `issue_id`=blocked,
  `depends_on_id`=blocker), `issue_type='epic'`, `status='closed'`.
- **Query templates** — the epic-closure audit and the dependency/bottleneck graph (today hardcoded
  in `epic-closure-audit.sh` / `dep-graph.sh`), parameterized *by the profile* rather than baked in.
- **Mirror discipline** — `bd-sync`, the three-layer mirror, plain-English naming.

The generic `dolt-query-analyst` agent **loads** this profile as input; it does not hardcode the bead
schema. That is the seam that proves the inversion: a second use-case adapter (any other Dolt schema)
would drop in beside beads without touching the agent.

---

## 5. Agent collapse — 5 → 3, by capability

Agents are organized **by capability, not by product** (Ken Thompson, doc 003). The 5 beads-named
agents collapse to 3 capability agents; beads-ness is quarantined in the `beads-adapter`.

| New agent | Capability | Merges (old) | Schema knowledge |
|---|---|---|---|
| **`dolt-operator`** | sync / remotes / push + server-sprawl / recovery | `dolt-sync-advisor` + `bead-recovery-specialist` | none (flavor-agnostic) |
| **`dolt-query-analyst`** | SQL-via-MCP graph / audit | `bead-dependency-mapper` + `bead-epic-auditor` | schema profile is **INPUT** |
| **`beads-adapter`** | `bd-sync` / three-layer-mirror / bead schema | `beads-guru` (kept; it is the legit beads home) | the one place bead schema lives |

Hard rule preserved from the current agents: **introspect the live schema, never assume it.** The
`dolt-query-analyst` confirms table/column/encoding against the live DB before trusting any query.

---

## 6. The mutation verb taxonomy (non-negotiable, cross-cutting)

This generalizes PR #2's "recommend-don't-execute" rule (just applied to `bd-sync`) into a
**substrate-wide** rule every agent inherits. Handing an LLM the full Dolt mutation surface against
content-addressed history is a silent, weeks-to-detect, irreversible data-loss footgun (Kleppmann,
doc 003). So destructive ops are made **structurally unreachable**.

| Verb class | Operations | Agent posture |
|---|---|---|
| **read** | `SELECT`, `dolt_log` / `dolt_diff` / `dolt_status`, `AS OF` | **executes freely** |
| **safe-write** | commit / insert / idempotent upsert on an **agent-owned branch `agent/<task>`** (never `main`) | **executes only off-main**, surfaces the result |
| **history-affecting** | `merge`→`main`, `push`, `push --force`, `reset --hard`, branch-delete, **data-PR merge** | **recommend-only; human executes** |

Enforcement is structural, not advisory:

1. **History-affecting `dolt-mcp` tools are excluded from every agent's `tools:` allowlist** — they
   are not reachable, full stop. (The validator's 3.11.0 body-vs-allowlist check is the gate that
   catches any agent body that references a tool not in its allowlist.)
2. **Agent merges halt on non-empty `dolt_conflicts`** — never auto-resolve.
3. **Ordering derives from commit-DAG ancestry, not timestamps** (content-addressed history has no
   reliable wall-clock order).
4. **DoltHub async writes poll-to-terminal before any retry** (no double-apply).
5. **Agent mutations land via a branch + DoltHub data-PR for human merge** — the safe write path.
6. **The core skill's `allowed-tools` narrows** from the too-broad `Bash(dolt:*)` to read +
   non-destructive subcommands only.

---

## 7. The `dolt-watch` routine

A radar that converts upstream Dolt progress into action items and keeps the maturity gates current.
Modeled on the IEP `spec-drift-watch` pattern but **Dolt-product-specific and owned by this plugin**
(in-repo, travels with the code — it is a *distinct* routine from the IEP kernel soak, doc 003).

- **Mechanism** — a scheduled **GitHub Actions** workflow in the plugin repo
  (`.github/workflows/dolt-watch.yml`, weekly `cron` + `workflow_dispatch`) running
  `scripts/dolt-watch.mjs`. On-demand runnable. (GH Action chosen over `/schedule` cloud routine or
  VPS cron for self-containment — it travels with the repo.)
- **Watched surfaces:**
  - GitHub releases/tags of `dolthub/{dolt, doltgresql, doltlite, dumbodb, dolt-mcp, dolt-workbench}`.
  - The DoltHub blog feed.
  - The `dolt-mcp` tool list (parsed from its source/README).
  - `docs.dolthub.com` product-status pages.
  - Current `dolt` + `dolt-mcp` versions.
- **State** — committed `dolt-watch/state.json` (last-seen version + tool-set + per-product
  maturity). Each run diffs current vs last-seen.
- **Signal → action rules:**

  | Signal | Action |
  |---|---|
  | new / removed `dolt-mcp` tool | "review for wiring / least-privilege" |
  | product maturity bump (alpha→beta→GA) | "promote that flavor adapter's maturity gate + run its eval" |
  | DumboDB ships 0.1 / DoltLite→beta | "build/upgrade that adapter against the now-stable surface" |
  | Dolt major-version bump | "re-verify VC-surface SQL + **re-pin `dolt-mcp`**" (today's `…@latest` is unpinned — Thompson's trust-the-binary flag; pin it) |

- **Output** — opens a **GitHub issue + a bead** (three-layer mirror via `bd-sync`) per action.
  (No ntfy / Plane mirror this round — owner decision, doc 003.) Updates `state.json` via PR.

This is the loop that flips a flavor's maturity gate `experimental → beta → GA` as upstream advances,
so the alpha adapters are *honest*, not vaporware.

---

## 8. Build sequence (v-sequence — all in scope; execution order; every step eval-gated)

This is **execution order, not a scope cut.** All four flavors + platform surfaces are in scope
(owner override, doc 003). Each step is gated on the repo's `eval.yaml` (Fowler, doc 003) — it
already caught a real v0.1.0 regression.

| Build | Delivers | New eval / gate |
|---|---|---|
| **Build 1** | core VC-surface skill + connection descriptor + `dolt`/MySQL (GA) + the 3 collapsed agents + beads adapter + safety taxonomy (§6) wired | beads `eval.yaml` stays **100% green** (strangler-fig regression gate) |
| **Build 2** | `doltgres`/Postgres adapter (validates the seam) + DoltHub **data-PR** safe-write path (§6) + Dolt-CI awareness | new Doltgres eval |
| **Build 3** | `doltlite`/SQLite (alpha) + `dumbo`/Mongo (experimental), **maturity-gated** (WARN + read/safe-write until `dolt-watch` reports GA) + Workbench/agent-mode + Hosted-Dolt-MCP awareness | per-adapter evals |

The **`dolt-watch` routine (§7)** is built between Build 1 and Build 2 (plan phase 4) so the alpha
adapters in Build 3 have a working maturity radar by the time they ship.

---

## 9. File-by-file transformation map

All paths under `~/000-projects/beads-dolt` (the plugin repo). The rename to `dolt-mcp-vcs` is
atomic (doc 003 §rename) and gated behind the greenlight.

| File | Transformation |
|---|---|
| `skills/beads-dolt/SKILL.md` | Reframe to the VC-surface **core**; beads → an Examples/adapter section. Skill dir renamed to the new slug. |
| `skills/beads-dolt/references/beads-dolt-internals.md` | **Preserve the verbatim-discipline** (the canon's favorite file); generalize to "Dolt internals: fetch live, never snapshot." |
| `agents/bead-dependency-mapper.md` + `agents/bead-epic-auditor.md` | **Merge → `dolt-query-analyst`**; bead schema becomes a **loaded profile**, not a hardcode. |
| `agents/dolt-sync-advisor.md` + `agents/bead-recovery-specialist.md` | **Merge → `dolt-operator`.** |
| `agents/beads-guru.md` | **→ `beads-adapter`** (keep — the legit beads home). |
| `.mcp.json` | Replace flavor/db literals with the **connection-descriptor** pattern; rename server key `beads-dolt` → `dolt-mcp-vcs`; wire only tools agents actually call (today 2 wired to agents: `query`, `list_databases`; `list_dolt_commits` is prose-only — referenced in `SKILL.md` / client `--help`, in no agent allowlist; see doc 001 §2.1). |
| `scripts/dolt-mcp-client.py`, `server-health.sh`, `dolt-idle-reaper.sh` | Already generic — **keep as core.** |
| `scripts/epic-closure-audit.sh`, `dep-graph.sh` | **Parameterize the SQL by schema profile** (beads becomes one profile). |
| `scripts/dolt-push-dolthub.sh` | Generalize from beads/DoltHub-only to the descriptor's remote. |
| `.claude-plugin/plugin.json` | Rename `name` `beads-dolt` → `dolt-mcp-vcs`; **rewrite `description`** — drop "five expert agents", reframe to "one VC core + thin maturity-gated adapters (beads = adapter #1)"; update the 9 `keywords` from beads-first to Dolt/VCS-first. (Path is under `.claude-plugin/`.) |
| `.claude-plugin/marketplace.json` | The plugin **self-identifies as `beads-dolt` in 3 places** — top-level `name`, `plugins[0].name`, and the descriptions — **all** must change to `dolt-mcp-vcs`; plus `keywords` and `category` (see the category row below). (Path is under `.claude-plugin/`.) |
| `README.md` | **Full rewrite** from beads-first to core+adapters. The current README's **"45 tools"** claim must become a **fetch-live statement** (e.g. "~40 tools — fetch the live `dolt-mcp` list, never freeze the count") — consistent with the anti-snapshot discipline; **never freeze the tool count** in prose. |
| `DOGFOOD.md` | Re-anchor every `skills/beads-dolt/…` path to the new skill-dir name; verify the dogfood walkthrough still resolves after the rename. (Apply DOGFOOD Finding 2 in the core `SKILL.md` per doc 004 §4.) |
| `.gitignore` | Review for any `beads-dolt`-specific entries (e.g. ignored paths keyed on the old slug) and re-key to the new slug. |
| `skills/<name>/eval.yaml` | Rename the `skill_name: beads-dolt` field to the new skill slug; Build 1a keeps beads criteria green, Build 1b ports the 5 test-cases into a `beads-adapter` eval **in the same commit as the reframe** (doc 004 §2 B3). |
| **`category` decision** | Today `category` is **`productivity`** (`plugin.json` `metadata.category`) and **`mcp`** (marketplace catalog). The panel recommends moving toward **`dev-tools`/`vcs`**; this is **decided at rename time** — set the final category in `plugin.json` + `marketplace.json` (+ the `claude-code-plugins` catalog) in the same atomic commit, not deferred. |
| **new** `.github/workflows/dolt-watch.yml` + `scripts/dolt-watch.mjs` + `dolt-watch/state.json` | The watch routine (§7). |
| **`claude-code-plugins` (the marketplace repo):** `sources.yaml` | Update the entry's `name` and `target_path: plugins/mcp/beads-dolt` → the new slug/path. |
| **`claude-code-plugins`:** `.claude-plugin/marketplace.extended.json` | Update this plugin's catalog entry (`name`, description, keywords, category) to the new identity. |
| **`claude-code-plugins`:** `.markdownlint-cli2.jsonc` | Update the synced-path ignore (`plugins/mcp/beads-dolt/**` → new path). Then run **`pnpm run sync-marketplace`** to regenerate `marketplace.json` + derived artifacts. |

**Rename mechanics (doc 003 §rename), one commit:** `rg 'mcp__beads-dolt__'` → rename the prefix in
**both** SQL agents' `tools:` allowlists **and** bodies in lockstep with the `.mcp.json` server key
(the 3.11.0 body-vs-allowlist check is the miss-detector). Update `plugin.json` /
`marketplace.json` name+description+keywords+category; `SKILL.md` `name`+triggers; the skill dir
rename. In **`claude-code-plugins`**: update the `sources.yaml` entry (`name` + `target_path:
plugins/mcp/beads-dolt` → new path), the `marketplace.extended.json` entry, and the
`.markdownlint-cli2.jsonc` synced-path ignore (`plugins/mcp/beads-dolt/**`); run `pnpm run
sync-marketplace`. GitHub repo rename `beads-dolt` → `dolt-mcp-vcs` (GitHub auto-redirects; install-
slug breakage is the accepted cost, doc 003).

> **Map-completion provenance:** the rows above the watch-routine line — `plugin.json`,
> `marketplace.json`, `README.md` (incl. the "45 tools" → fetch-live fix), `DOGFOOD.md`, `.gitignore`,
> the `eval.yaml` `skill_name` rename, the category decision, and the three `claude-code-plugins`
> rows — were added because the engineering panel (architect-reviewer + Thompson, doc 004 §3 MAJORS
> "§9 map incomplete + factual errors") found the original map incomplete and carrying the same
> "3 wired" factual error corrected in §0/§9 and doc 001 §2.1. This is now the complete atomic-rename
> spec.

---

## 10. Verification gates (per the plan's §8)

| Gate | Check |
|---|---|
| **Per phase** | `pnpm exec j-rig check <skill-dir>` (Tier 3A) green; `eval.yaml` stays `decision: allow` for all beads criteria; each new adapter ships + passes its own `eval.yaml`. |
| **Rename** | `python3 ~/000-projects/claude-code-plugins/scripts/validate-skills-schema.py --agents-only .` → no body-vs-allowlist errors; `rg 'beads-dolt'` shows only intentional historical refs; `pnpm run sync-marketplace` + markdownlint clean. |
| **Safety taxonomy** | assert **no agent `tools:` grants a history-affecting MCP tool**; spot-check each agent body recommends (not executes) destructive ops. |
| **Watch routine** | `workflow_dispatch` a first run; confirm it writes `state.json`, detects a seeded delta, and opens an issue + bead. |
| **Beads still works** | the beads visibility-diagnosis + remote-add/push flow passes its eval **unchanged** (strangler-fig regression gate). |

---

## 11. Explicitly NOT in scope

- The IEP `spec-drift-watch` / kernel soak (separate, owner's other work — `dolt-watch` is a
  distinct, plugin-owned radar).
- Wiring all ~40 `dolt-mcp` tools (per-need only).
- The `claude-code-plugins` validator `_RE_MCP_FQ` kebab-case regex bug — already captured as bead
  `claude-2cvm`; independent of this work.
