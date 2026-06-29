# 000-docs index — beads-dolt → dolt-mcp-vcs

Document inventory for the `beads-dolt` plugin (being inverted into the Dolt-first `dolt-mcp-vcs`
platform plugin). Flat-by-default per Document Filing Standard v4.4; `NNN` is one global chronological
sequence.

## Documents

| NNN | Code | Title | Purpose |
|---|---|---|---|
| 001 | RL-RSRC | [DoltHub product family + dolt-mcp capability map (2026)](001-RL-RSRC-dolthub-product-family-map.md) | Research synthesis — the 2026 DoltHub product family + the `dolt-mcp` tool surface. Informs 002. |
| 002 | AT-ARCH | [Architecture blueprint — `dolt-mcp-vcs`: one VC core + thin adapters](002-AT-ARCH-dolt-mcp-vcs-blueprint.md) | The build spec: one-core-+-adapters design, connection descriptor, maturity-gated flavor adapters, 5→3 agent collapse, mutation verb taxonomy, `dolt-watch` routine, build sequence, file-by-file map. |
| 003 | AT-DECR | [Decision Record — invert `beads-dolt` into a Dolt-first platform plugin](003-AT-DECR-dolt-first-platform-inversion.md) | Records the inversion; preserves the 5-seat canon's overridden dissent **verbatim** (full-platform-now + slug-freeze); the owner's overrides; the adopted mitigations (`dolt-watch`, maturity-as-data, safety taxonomy, eval-gate); the slug-is-a-public-contract clause + accepted breakage. |
| 004 | RA-REVW | [Engineering panel review — the plan-of-record (D1–D3)](004-RA-REVW-engineering-panel-review.md) | The 6-seat engineering-panel review record. **Unanimous `proceed-with-changes`** (6/6; 0 abandon, 0 proceed-clean): architecture sound, fixes are enforcement + execution-readiness. Preserves each finding by seat: 6 BLOCKERs (→ Phase 0, gating Build 1), 9 MAJORs + 3 MINORs (→ revised plan). Drives the Task-A corrections in 001 + 002. |

## Reading order

1. **001** for the landscape (what exists upstream, at what maturity).
2. **002** for the architecture (how the plugin is decomposed and built).
3. **003** for the decision (what was decided, what the canon argued, what was overridden and why).
4. **004** for the engineering-panel review (the must-fixes that gate Build 1 + the folded-in changes).

## Code reference (Document Filing Standard v4.4)

- **RL** Research & Learning · **RSRC** research synthesis
- **AT** Architecture & Technical · **ARCH** architecture · **DECR** decision record
- **RA** Review & Audit · **REVW** review record

## Status

Phase 1 deliverable of the plan *"invert `beads-dolt` → a Dolt-first platform plugin (`dolt-mcp-vcs`),
with a Dolt-advancement watch routine."* The four docs precede a **greenlight checkpoint**; the
rename + build phases (002 §8) execute only after greenlight. A **6-seat engineering panel** (doc 004)
reviewed the plan-of-record and returned a **unanimous `proceed-with-changes`** — its 6 must-fixes are
folded into a gating **Phase 0** (pre-Build-1), and its MAJORs/MINORs into the revised plan; the
review also drove the Task-A corrections now in 001 + 002 (the "2 wired, not 3" fact, the descriptor
§2 reframe, and the completed §9 rename map).
