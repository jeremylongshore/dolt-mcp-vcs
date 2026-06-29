# DoltHub product family + dolt-mcp capability map (2026)

| | |
|---|---|
| **Doc** | 001-RL-RSRC-dolthub-product-family-map |
| **Category** | RL — Research & Learning · RSRC — research synthesis |
| **Status** | Reference (informs the architecture blueprint, doc 002) |
| **Author** | Jeremy Longshore \<jeremy@intentsolutions.io\> |
| **Date** | 2026-06-29 |
| **Source** | This session's research (3 Explore-agent sweeps) + the `beads-dolt` repo's own anti-snapshot reference (`skills/beads-dolt/references/beads-dolt-internals.md`) |
| **Related** | 002 (architecture blueprint), 003 (decision record) |

---

## 0. Why this doc exists (and what it is *not*)

This is the **strategic snapshot** that justifies inverting the `beads-dolt` plugin from a
beads-first tool into a Dolt-first platform plugin. It records the 2026 DoltHub product family and
the shape of the `dolt-mcp` tool surface as researched **on the date above**.

It is deliberately split into two halves with different shelf lives:

- **§1 Product family** — strategic context (which products exist, their maturity, what engine they
  share). This moves on the order of *months* and is safe to write down. Even so, the maturity
  column is the field the `dolt-watch` routine (blueprint §4) keeps honest — treat it as
  *last-verified*, not *permanent*.
- **§2 `dolt-mcp` tool surface** — this is **operational truth that goes stale on every upstream
  release**. Per the repo's existing discipline (the canon called `references/beads-dolt-internals.md`
  the best file in the repo), this doc records the tool *families* and the *live source of record*,
  and explicitly **does not** freeze the exact ~40-tool list into prose. Anything an agent acts on
  is fetched live. A baked tool table silently lies the moment DoltHub ships.

If this doc and the installed binary / live `dolt-mcp` source ever disagree, **the live source
wins** — the same authority order the plugin's agents already follow.

---

## 1. The DoltHub product family (2026)

All of these are built on **one engine** — the **Prolly-tree** (probabilistic B-tree) content-addressed
storage that gives every product the same Git-for-data primitives: `branch`, `merge`, `diff`,
`log`, time-travel (`AS OF`), `commit`, and data pull-requests. That shared engine is the entire
basis for the blueprint's "one core + adapters" decomposition (doc 002 §1) — the products differ
only in **wire protocol / SQL dialect** and **maturity**, not in version-control semantics.

### 1.1 The four database flavors

| Flavor | Product | Wire protocol / dialect | Maturity (last-verified 2026-06-29) | Notes |
|---|---|---|---|---|
| **dolt** | Dolt 2.0 | MySQL | **GA** (2.0, May 2026) | The real, stable target. The reference backend. |
| **doltgres** | Doltgres | PostgreSQL | **~GA** (1.0 ≈ Apr 2026) | Second real backend. `dolt-mcp` speaks it via `--doltgres`. The adapter that *validates the seam* (if the core is truly dialect-invariant, Postgres proves it). |
| **doltlite** | DoltLite | SQLite (embeddable) | **alpha** (Mar 2026) | Embeddable C / Python / Go. "The new Dolt SQLite." Maturity-gated until `dolt-watch` reports a bump. |
| **dumbo** | DumboDB | MongoDB (FerretDB-based) | **pre-0.1, experimental** | Versioned document store. Built by AI agents in DoltHub's "Gas Town" — the same origin as `beads` itself. Most volatile surface; strictly read/safe-write until it stabilizes. |

### 1.2 The platform / SaaS surfaces

| Surface | What it is | Relevance to the plugin |
|---|---|---|
| **DoltHub SaaS** | Hosted catalog + remotes. Pro now **$5/mo**. Ships a **SQL API**, an **agent mode**, and **Dolt CI**. | The data-PR / SQL-API write path (blueprint §3 safe-write) and CI-awareness (Build 2). |
| **Hosted Dolt** | Managed always-on Dolt servers. | A connection-descriptor `endpoint` target; Hosted-Dolt-MCP awareness (Build 3). |
| **DoltLab** | Self-hostable DoltHub (on-prem). | Another `endpoint` target; no special-casing needed under the descriptor model. |
| **Dolt Workbench** | Agent-mode SQL IDE / web workbench. | Awareness surface (Build 3); not wired, but the watch routine tracks its releases. |

### 1.3 The one thing to remember

> Four flavors, several hosting surfaces, **one** branch/merge/diff/`AS OF`/commit/data-PR model.

This is the load-bearing fact. It is *why* "full platform now" does not mean "4× the work":
the version-control surface is written once; each flavor is a thin descriptor + a maturity gate.
See doc 002 for how that decomposition is built.

---

## 2. The `dolt-mcp` capability map

**Repo of record:** <https://github.com/dolthub/dolt-mcp> (launched Aug 2025).
**Binary:** `dolt-mcp-server`, today installed via `go install github.com/dolthub/dolt-mcp/mcp/cmd/dolt-mcp-server@latest`.

### 2.1 Scale, and the gap this research found

`dolt-mcp` exposes **~40 tools** over the shared version-control surface. The current `beads-dolt`
plugin wires exactly **two** of them to its agents' `tools:` allowlists:

- `query` — run SQL (the workhorse).
- `list_databases` — enumerate databases on the server.

A third tool, `list_dolt_commits` (read commit history), is **referenced in prose only** — it appears
in `SKILL.md` and the `dolt-mcp-client.py` `--help`, but is **not granted in any agent's `tools:`
allowlist**, so no agent can actually call it. The honest count is therefore **2 of ~40 wired to
agents**, not three.

That is **2 of ~40** — appropriate for a beads-first tool, but it leaves the entire
version-control surface (branch, merge, diff, remote, data-PR, conflicts, status) unexposed. The
inversion's job is **not** to wire all 40 (see Thompson's "by capability, not for completeness" in
doc 003) — it is to wire each additional tool *as a named agent capability demands it*, least-privilege.

### 2.2 Tool *families* (not a frozen list — fetch the exact names live)

The ~40 tools group into the families below. **These family names are a map, not an API contract** —
the exact tool identifiers, arguments, and additions/removals are read live from the `dolt-mcp`
source/README at the time of use (and the `dolt-watch` routine diffs that list every week). The
verb-class column ties each family to the mutation taxonomy in blueprint §3.

| Family | What it covers | Mutation verb-class (blueprint §3) |
|---|---|---|
| **Connection / database** | list databases, select database, server info | read |
| **Query** | `SELECT` and DML via SQL | read *or* safe-write depending on the statement |
| **History / status** | `dolt_log`, `dolt_status`, `dolt_diff`, time-travel `AS OF` | read |
| **Commit** | stage + `dolt_commit` on a working set | safe-write (agent-owned branch only) |
| **Branch** | create / list / checkout / delete branches | create=safe-write · **delete=history-affecting** |
| **Merge** | merge a branch; surface conflicts | **history-affecting** (into `main`); halt on `dolt_conflicts` |
| **Remote** | add/list remotes, `push`, `pull`, `fetch` | **history-affecting** (`push`, `push --force`) |
| **Data PR** | open / read / merge DoltHub data pull-requests | open=safe-write · **merge=history-affecting (human)** |
| **Reset / revert** | `reset --hard`, revert | **history-affecting** |

The single most important consequence: **the history-affecting families are never granted to an
agent's `tools:` allowlist.** They are structurally unreachable, not merely discouraged
(blueprint §3, decision record §3).

### 2.3 Connection parameters (the literals the descriptor replaces)

Today `.mcp.json` hardcodes a beads-specific connection:

```
--dolt --host 127.0.0.1 --port 3308 --user root --database beads
```

`dolt-mcp` also accepts `--doltgres` (Postgres flavor) and standard host/port/user/database/password
flags. The blueprint replaces these literals with a **connection descriptor** value
(`{ flavor, endpoint, database, creds-ref, maturity }`) so flavor and maturity become *data*, not
hardcoded structure (blueprint §1).

---

## 3. The current `beads-dolt` plugin — what's being inverted

For completeness, the artifact this research is acting on (v0.1.0, ~9 days old at time of writing):

- **1 skill** (`skills/beads-dolt/SKILL.md`) — beads-first: diagnoses "my beads aren't on DoltHub"
  (root cause: no remote), prescribes `bd dolt remote add` + `push`, corrects the rapid-write-race
  misconception, routes to agents.
- **5 agents** — `dolt-sync-advisor`, `bead-epic-auditor`, `bead-dependency-mapper`,
  `bead-recovery-specialist`, `beads-guru`.
- **1 wired MCP server** (`.mcp.json`) — `dolt-mcp-server`; 2 tools wired to agents (`query`,
  `list_databases`); `list_dolt_commits` is referenced in prose (SKILL.md / client `--help`) but
  in no agent allowlist.
- **scripts/** — `dolt-mcp-client.py`, `server-health.sh`, `dolt-idle-reaper.sh` (generic);
  `epic-closure-audit.sh`, `dep-graph.sh` (beads-schema-specific SQL); `dolt-push-dolthub.sh`.
- **eval.yaml** — a behavioral eval that already caught a real v0.1.0 regression (Fowler's reason to
  gate every phase on it).
- **The best file in the repo** (per the canon): `references/beads-dolt-internals.md` — the
  anti-snapshot discipline. It is generalized, not discarded, by the inversion.

The inversion keeps every one of these assets and re-frames them around the version-control core.
The "how" is doc 002.

---

## 4. Sources & live-fetch pointers (authority order — higher wins)

1. **The installed binary / live server** — `dolt --help`, `dolt-mcp-server --help`, live schema
   introspection, `bd dolt show`. Current to exactly what's running.
2. **Official upstream docs** (maintained with the code):
   - Dolt: <https://docs.dolthub.com> · <https://github.com/dolthub/dolt>
   - Doltgres: <https://github.com/dolthub/doltgresql>
   - `dolt-mcp`: <https://github.com/dolthub/dolt-mcp> (the canonical tool list)
   - DoltHub blog (product announcements / maturity bumps): <https://www.dolthub.com/blog>
3. **This doc** — a dated synthesis. Strategic context (§1) is durable; the tool surface (§2) is a
   map whose exact contents are fetched live. When in doubt, fetch.

> **Maintenance note:** the `dolt-watch` routine (blueprint §4) is the mechanism that keeps §1's
> maturity column and §2's tool families current. When `dolt-watch` reports a delta, this doc's
> §1.1 maturity column and §2.2 families are the two things to reconcile.
