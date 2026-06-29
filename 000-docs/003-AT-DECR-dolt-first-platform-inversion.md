# Decision Record — invert `beads-dolt` into a Dolt-first platform plugin (`dolt-mcp-vcs`)

| | |
|---|---|
| **Doc** | 003-AT-DECR-dolt-first-platform-inversion |
| **Category** | AT — Architecture & Technical · DECR — Decision Record |
| **Status** | **Decided** (owner is final decider). Canon dissent preserved verbatim. Awaiting greenlight to execute. |
| **Author** | Jeremy Longshore \<jeremy@intentsolutions.io\> |
| **Date** | 2026-06-29 |
| **Decides** | the inversion of the `beads-dolt` plugin; its new identity; scope; and the adopted risk-mitigations |
| **Implements** | doc 002 (architecture blueprint) over doc 001 (product-family research) |
| **Review method** | 5-seat thinker canon (Ken Thompson, Linus Torvalds, Rich Hickey, Martin Kleppmann, Martin Fowler) → owner override on two points |
| **Transcript of record** | `~/.claude/projects/-home-jeremy-000-projects-claude-code-plugins/b3575220-8812-461c-aae5-76f5371bf4ad.jsonl` |

---

## 1. Decision, in one paragraph

Evolve the published `beads-dolt` plugin **in place** into a **Dolt-first platform plugin** whose new
identity is **`dolt-mcp-vcs`** (plugin/slug + MCP-server id), covering the whole 2026 DoltHub product
family as thin **maturity-gated adapters over one dialect-invariant version-control core**, with
**beads demoted to use-case adapter #1**. The owner, as final decider, **overrode the canon on two
points** it was near-unanimous about — *full-platform-now* and *renaming the slug in place* — and in
the same breath commissioned the mitigation that makes those overrides survivable: an **owner-originated
`dolt-watch` routine** that turns upstream Dolt advancement into action items and keeps each adapter's
maturity gate honest. The canon's other contributions (Hickey's one-core decomposition, Kleppmann's
mutation-safety taxonomy, Thompson's by-capability agents + pin-the-binary, Fowler's eval-gate) were
**adopted**. This record preserves the overridden dissent **verbatim** so future readers can see exactly
what was argued and re-litigate from the real positions if the bet sours.

---

## 2. Context & the question

`beads-dolt` v0.1.0 (first commit 2026-06-19; ~9 days old at decision time) is a **beads-first** plugin:
one skill + 5 beads-named agents + a wired `dolt-mcp` server that wires **3 of `dolt-mcp`'s ~40 tools**.
The owner wanted to invert it into a Dolt-first platform where beads is one use-case, covering the 2026
DoltHub family (Dolt 2.0/MySQL GA, Doltgres/PG ~GA, DoltLite/SQLite alpha, DumboDB/Mongo pre-0.1, +
DoltHub SaaS/Workbench/Dolt-CI). See doc 001 for the verified product map.

The owner's **first-round** calls (transcript line 442) were:

> "How should the new Dolt-first plugin relate to the existing beads-dolt plugin?" = **"Evolve beads-dolt
> in place"** · "How broad should the first version (v1) be?" = **"Full platform now"** · "What should I
> produce first?" = **"get with the thinker canon and tehn yes do number one use intent blueprint docs
> and keep the decision record in place make sure we are using /doc-filing"**

So before deciding, the owner explicitly asked to pressure-test the design with the canon. The canon came
back against both "evolve in place + rename" and "full platform now." The owner then **reaffirmed both as
explicit overrides** (line 483). This record exists because the owner asked for the canon *and* chose to
override it — both halves are part of the decision.

---

## 3. The canon review — each seat's core position (verbatim)

> **Ken Thompson** — *"The inversion is right. 'Full platform now' is wrong. Ship the Dolt-generic core
> that already exists, keep beads as the one working adapter, and refuse to first-class anything you
> can't connect to and run a query against today. … Don't gold-plate it."*

> **Linus Torvalds** — *"I read the actual plugin before I read your proposal, and here's the problem:
> the thing on disk is good, and the proposal is a plan to ruin it. You're proposing to wrap a cathedral
> around a `.mcp.json` that currently wires 2 of ~40 tools."*

> **Rich Hickey** — *"Dolt's essence … is version-controlled relational data: a commit/branch/merge/
> diff/AS-OF surface over rows. That is one thing. The four 'products' (MySQL, Postgres, SQLite, Mongo
> flavors) are not four things; they are one versioned-data model wearing four wire-protocols. … The
> 'full platform now, evolve in place' decision is the easy decision … The simple decision is to find
> the one fold and build the plugin around it."*

> **Martin Kleppmann** — *"Dolt is a Prolly-tree, content-addressed, history-preserving store, which
> means its failure modes are not 'slow query' or 'row missing.' They are history corruption and silent
> conflict swallowing — exactly the class that runs for weeks before anyone notices. 'Full platform now
> + evolve in place' conflates two axes — surface breadth and mutation authority — that must move on
> separate, gated tracks."*

> **Martin Fowler** — *"This is a textbook StranglerFigApplication: you don't reframe, you extract a
> generic core and make beads the first adapter behind it, one capability at a time, while the published
> v0.1.0 keeps serving its users unchanged. 'Full platform' is a destination you walk to, not a thing
> you ship."*

---

## 4. The two overridden dissents (verbatim steel-man + owner override)

### 4a. "Full platform now" — **unanimous canon NO**, overridden

All five seats argued against first-classing alpha/pre-0.1 backends now. The strongest steel-manned
statements:

> **Linus Torvalds (Finding 1):** *"'FULL PLATFORM NOW' includes DumboDB (pre-0.1) and DoltLite (alpha)
> as first-class. You cannot build a stable adapter against an unstable target. … Every line you write
> against it is pre-obsolete. … The alpha/pre-release pair will eat 60% of the effort for 0% of today's
> users — nobody is hitting DumboDB through this plugin today. This is architecting for an imagined
> future, the exact thing I've spent thirty years refusing."*

> **Ken Thompson (Finding 1):** *"You ship 6 backends of which 2 work. The 4 dead ones become
> load-bearing for nobody and impossible to remove without looking like a retreat. That's the most
> expensive kind of feature — added once, owned forever. … First-class exactly Dolt 2.0 (GA). Mark
> Doltgres as a documented seam … DoltLite/DumboDB/Workbench/CI get one paragraph in the README."*

> **Martin Fowler (Finding 1):** *"'Full platform now' … is speculative architecture wearing an
> enabling-architecture costume. DumboDB is pre-0.1 — there is no stable backend to build an adapter
> against. … Build the abstraction from two real implementations, never one and a forecast. Rule of
> Three."*

> **Rich Hickey (Finding 2):** *"'Full platform now' complects readiness with surface area. … Shipping a
> plugin that presents pre-0.1 and GA behind the same door says 'these are the same kind of thing.' They
> are not — one is a value you can rely on, one is a promise."*

**Owner override (verbatim, line 483):**

> *"i want u to do 2 but create a indepth /routine that looks for upDates from dolt that signals use to
> take action on our end based on their advancement"*

— where menu option **2** = *"Full platform now anyway / Override the canon: first-class all four flavors
(incl. alpha/pre-0.1) + Workbench/Dolt-CI from v1."*

**How the override is made survivable (the owner's own condition + the adopted canon mitigations):**

1. **`dolt-watch` routine (owner-originated, §7).** The owner did not merely override — they *attached a
   mitigation* that no reviewer proposed: a radar that watches Dolt's upstream advancement and signals
   action on our end. This is the answer to "you can't build against an unstable target": the adapter is
   built thin and **the maturity gate is kept honest by the radar**, flipping `experimental → beta → GA`
   as upstream actually ships.
2. **Maturity-as-data (Hickey's own mitigation, adopted).** Hickey's dissent *contained its own override
   path*: *"Make maturity data, per adapter … The other two register as adapters whose capability map says
   'experimental,' and the core refuses or warns rather than pretending."* The blueprint (doc 002 §3)
   implements exactly this — alpha/experimental flavors WARN and are restricted to read/safe-write. So
   "full platform now" ships the alpha adapters **honestly labeled and write-gated**, not pretending to be
   GA. This narrows the gap between the override and the dissent to almost nothing.
3. **Kleppmann's two-axis split is respected, not ignored.** Surface-breadth (all four flavors) and
   mutation-authority (the §6 taxonomy) move on *separate* tracks: breadth is wide from v1, but write
   authority on every flavor is gated by the verb taxonomy and, for pre-GA flavors, further restricted.

> **Recorded honestly:** the canon was right that building stable code against pre-0.1 targets is waste.
> The override's bet is that **thin adapters + a maturity radar + write-gating** convert that waste into a
> cheap, honest option on the future — present but inert until `dolt-watch` says the target is real. If
> `dolt-watch` shows the alpha adapters churning faster than they're worth, the documented retreat is to
> drop them back to README stubs (Thompson's original mitigation), which the maturity-as-data design makes
> a one-field change, not a refactor.

### 4b. "Rename the slug in place" — **the least-reversible move**, overridden

Argued most forcefully by Fowler (public-contract framing), with Linus and Thompson (mechanical-risk
framing). The canon called this *"the single least-reversible decision in the whole proposal."*

> **Martin Fowler (Finding 2):** *"The install slug, plugin `name`, catalog id, and the marketplace
> auto-sync path … are all `beads-dolt`. The CLAUDE.md for the marketplace is explicit that the public
> install slug is a 'breaking API change' to rename … Rename `beads-dolt` → `dolt-first` (or whatever) and
> every existing install, every README link, the catalog entry, and the sources.yaml sync break at once.
> This is the single least-reversible decision in the whole proposal. Reversibility cost: high and
> externally borne — your users pay it, not you. … Never rename in place. Record this in the Decision
> Record as an explicit reversibility clause: 'the slug is a public contract; additive new-slug, never
> destructive rename.'"*

> **Fowler, naming this his single most-costly item:** *"You cannot un-break every existing install, every
> cached README link, and the marketplace sync path once you rename `beads-dolt` in place … Freeze the slug
> as a public contract, make any Dolt-first identity additive, and pause any merge that proposes a
> destructive rename. That one clause in the Decision Record is worth more than the entire phase plan,
> because it's the only decision here you can't buy back cheaply."*

> **Linus Torvalds (Finding 4):** *"You inherit all the back-compat pain of the CCPI repo's 'do not
> normalize identifiers' rule — the slug is hardcoded in install snippets and READMEs. Inverting the
> identity in place breaks every existing trigger and install path to serve a platform that doesn't exist
> yet. … Leave `beads-dolt` exactly as it is — it's A-grade and it ships."*

> **Ken Thompson (Finding 4), the mechanical-lockstep version:** *"Renaming `beads-dolt` → some `dolt`-first
> slug changes the SKILL `name`, the MCP server id (`mcp__beads-dolt__query` is hard-referenced in two
> agents' `tools:` allowlists), and the install path. … Silent runtime breakage … your own validator
> (schema 3.11.0 body-vs-allowlist check) will catch the mismatch … but only if you remember to update
> both the `.mcp.json` server key and every agent allowlist in lockstep. … Pick the new MCP server id once,
> grep for the old `mcp__beads-dolt__` prefix across all agents, change them together in one commit."*

**Owner override (verbatim, line 483):**

> *"Rename beads-dolt → dolt-first in place now"*

— the menu option labeled *"Override: reframe the existing repo's identity now — new name, MCP server id,
triggers, catalog entry — accepting the breaking-slug cost for current installs/READMEs."*

**Accepted-breakage clause (the owner's override, recorded as the canon asked it to be):**

- The install slug **is a public contract.** Renaming `beads-dolt` → `dolt-mcp-vcs` in place **breaks**
  every pinned install of the old slug, cached README links, the catalog id, and the `sources.yaml` sync
  path — and the owner **accepts that cost** as the price of a clean Dolt-first identity now rather than a
  compat-shim indirection later.
- **Scope of the breakage, precisely:** the GitHub *repository* rename `beads-dolt` → `dolt-mcp-vcs` gets
  GitHub's automatic repo-level redirect (so `git clone …/beads-dolt` and the repo URL keep resolving) —
  **note this redirect softening is from the plan / project CLAUDE.md, not from the canon; no reviewer used
  "301/redirect" language.** What the redirect does **not** save: the marketplace **install slug**, the
  **catalog id**, hardcoded **README/install-snippet** references, and the **`marketplace.extended.json` /
  `sources.yaml`** sync path — those are updated by us and break for anyone pinned to the old name.
- **Mechanical execution (Thompson's mitigation, adopted in full):** the rename is **one atomic commit** —
  `rg 'mcp__beads-dolt__'`, change the prefix in both SQL agents' `tools:` allowlists **and** bodies in
  lockstep with the `.mcp.json` server key, with the **schema 3.11.0 body-vs-allowlist check as the
  miss-detector gate**. (Blueprint doc 002 §9.)
- **The canon's alternative is preserved on the record, not erased:** Fowler's additive-new-slug +
  `beads-dolt`-as-compat-shim (strangler pattern on naming) was the recommended-safe path. It was **not**
  chosen. If the breakage proves more costly than expected, that strangler path remains the documented
  fallback.

---

## 5. Adopted canon guidance (baked into doc 002, not re-litigated)

These were accepted as-is and are load-bearing in the blueprint:

- **Rich Hickey — one core concept.** *"Make the version-control surface the core and the only top-level
  concept: `branch`, `merge`, `diff`, `log`, `as-of`, `data-PR`. These are dialect-invariant. A flavor is
  a thin connection descriptor (wire-protocol + dialect quirks), not a silo. … Neither [beads nor a
  product] is the center. The version-control surface is."* → blueprint §1–§2.
- **Martin Kleppmann — mutation-safety as a substrate verb taxonomy.** *"Make history-destroying
  operations structurally unreachable from agent tool grants, not merely discouraged … the MCP tool
  allowlist exposed to agents must exclude any force/reset/branch-delete tool; those become recommend-only
  output."* The three-tier **read / safe-write / history-affecting** taxonomy is adopted verbatim →
  blueprint §6.
- **Ken Thompson — agents by capability, not product; pin the binary.** *"Collapse to 3 agents, organized
  by Dolt capability, not by product."* + *"`dolt-mcp-server` is installed via `go install …@latest`
  (unpinned) … the whole plugin's correctness rests on a binary it doesn't pin or verify. … pin the
  dolt-mcp version and say what you trust."* → blueprint §5 (5→3 collapse) and §7 (the watch routine's
  "Dolt major-version bump → re-pin `dolt-mcp`" rule).
- **Martin Fowler — gate every phase on `eval.yaml`.** *"Make the existing `eval.yaml` the non-negotiable
  regression gate for every phase … Each new adapter ships its own eval.yaml … No phase merges with a
  `decision: block`."* → blueprint §8 + §10. (`eval.yaml` already caught a real v0.1.0 regression — this
  is an empirically earned gate, not ceremony.)

---

## 6. The new identity — naming lineage & the resolved slug

The new name evolved across the decision; recording the lineage so the transcript's "dolt-first" doesn't
confuse a future reader:

1. **Owner's first override word (transcript line 483):** *"Rename beads-dolt → **dolt-first** in place
   now."* — "dolt-first" was the *descriptor of intent*, not a finalized slug.
2. **The architecture plan refined the candidate set** to `dolt` (default) / `dolt-vcs` / `dolt-mcp`,
   noting `dolt` could read too generic.
3. **At approval (this session) the owner chose** among them with the answer *"dolt mcp vcs."* Resolved to
   the slug **`dolt-mcp-vcs`** — it carries all three tokens the owner gave, is unambiguous in the catalog,
   and (unlike the bare `dolt-mcp`) **does not collide** with DoltHub's own `github.com/dolthub/dolt-mcp`
   repo. Bare `dolt` was rejected as too generic (reads as the product itself); bare `dolt-mcp` was rejected
   for the upstream namespace clash.

**Resolved:** plugin/slug + MCP-server id = **`dolt-mcp-vcs`**; display "Dolt — versioned-database
version-control toolkit (via dolt-mcp)." This is re-surfaced at the greenlight checkpoint so the owner can
veto before the atomic rename (plan phase 2) executes — the slug is a public contract, so it gets one last
confirm before it becomes irreversible-by-the-accepted-breakage-clause (§4b).

---

## 7. The owner-originated mandate — `dolt-watch`

Distinct from any reviewer recommendation, the owner **commissioned a new routine** as the explicit
condition attached to the full-platform override (line 483): *"create a indepth /routine that looks for
upDates from dolt that signals use to take action on our end based on their advancement."*

This is specified in blueprint doc 002 §7: a plugin-owned GitHub Actions routine (`dolt-watch.yml` +
`scripts/dolt-watch.mjs` + committed `dolt-watch/state.json`) that watches upstream Dolt
releases/blog/tool-list/product-status, diffs against last-seen state, and emits an **action item per
signal** — opening a **GitHub issue + a bead** (three-layer mirror via `bd-sync`; no ntfy/Plane this round
per owner decision at approval). Its load-bearing job is to **flip each flavor adapter's maturity gate** as
upstream advances, which is precisely what makes the "full platform incl. alpha" override honest rather
than vaporware. It is **distinct from** the IEP `spec-drift-watch` / kernel soak (owner's separate work).

---

## 8. Consequences

**Positive:**
- One core + thin adapters means the 4th flavor is cheap, not a 4× copy (Hickey's decomposition realized).
- Destructive Dolt operations are structurally unreachable from agents (Kleppmann's footgun closed).
- The plugin gains a self-maintaining maturity radar (`dolt-watch`) — the override's safety mechanism.
- Beads keeps working unchanged (strangler-fig regression gate on `eval.yaml`).

**Costs / accepted risks:**
- **Slug breakage** for pinned installs of `beads-dolt` (§4b) — accepted, externally borne.
- **Maintenance tax** of adapters against pre-GA targets (the canon's core worry) — mitigated by
  thin-adapter + maturity-gate + `dolt-watch`, with the README-stub retreat documented as fallback.
- **Binary trust** — `dolt-mcp-server` must be pinned (Thompson); `dolt-watch` enforces re-pinning on Dolt
  major bumps.

**Revisit conditions** (when to re-open this record):
- `dolt-watch` reports the alpha/experimental adapters churning faster than their value → execute the
  Thompson retreat (drop to README stubs; maturity-as-data makes it a one-field change).
- The slug breakage causes material user pain → the Fowler strangler-shim path (§4b) is the documented
  recovery.
- The override bet on "thin adapters over unstable targets" proves false in practice → this record's §4a
  preserves the unanimous dissent to re-decide from.

---

## 9. Status

**Decided** by the owner as final decider, with canon dissent preserved verbatim (§3–§4). **Execution is
gated on the greenlight checkpoint** (plan phase 1 → 2). Nothing destructive (the atomic rename, the GitHub
repo rename) runs before that checkpoint. The bead mirror for this initiative is created in the
`claude-code-plugins` workspace (the marketplace repo this plugin syncs into).

> The canon was asked, heard, and overruled on two points — and the override carries its own mitigations
> (the `dolt-watch` radar, maturity-as-data, the eval-gate, the lockstep rename). That is the difference
> between overriding a review and ignoring one. This record is the receipt.
