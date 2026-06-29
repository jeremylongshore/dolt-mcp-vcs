# Engineering panel review — the `beads-dolt` → `dolt-mcp-vcs` plan-of-record (D1–D3)

| | |
|---|---|
| **Doc** | 004-RA-REVW-engineering-panel-review |
| **Category** | RA — Review & Audit · REVW — review record |
| **Status** | Review record — folded into the revised plan (BLOCKERs → Phase 0; MAJORs/MINORs → revised plan) |
| **Author** | Jeremy Longshore \<jeremy@intentsolutions.io\> |
| **Date** | 2026-06-29 |
| **Reviews** | the filed plan-of-record **D1–D3** (001 product-family research · 002 architecture blueprint · 003 decision record) |
| **Verdict** | **unanimous `proceed-with-changes` (6/6; 0 abandon, 0 proceed-clean)** |
| **Panel** | Rich Hickey · Martin Kleppmann · Ken Thompson · Martin Fowler · architect-reviewer · security-auditor (6 seats) |
| **Transcript of record** | `~/.claude/projects/-home-jeremy-000-projects-claude-code-plugins/6905e0a4-2b72-4763-adad-753eec319aa5.jsonl` — the verbatim deliberation. This doc is the **synthesis-of-record**. |
| **Related** | 001, 002, 003 (the reviewed plan); corrections from this review land in 001 §2.1 / §3 and 002 §0 / §2 / §9 (see doc 002, Task-A edits) |

---

## 1. Verdict

The architecture is **sound** and is **not** redesigned by this review. The one-core-+-adapters
decomposition (Hickey, doc 003 §5), maturity-as-data (doc 002 §2–§3), the mutation verb taxonomy
(Kleppmann, doc 002 §6), and the `dolt-watch` radar (doc 002 §7) all survive intact. Every finding
below is an **enforcement or execution-readiness gap** — a place where the plan *asserts* a safety
property the repo does not yet *enforce*, or sequences an irreversible move ahead of the gate that
should guard it. The panel returned a **unanimous `proceed-with-changes`** (6/6; zero seats voted to
abandon, zero voted to proceed unchanged). The fixes harden the plan's enforcement and re-order its
first moves; they do not change what is being built.

---

## 2. BLOCKERS — must land before Build 1 / Phase 0

These six are gating. Each states the finding, the seats that raised it, and the adopted fix. They
are scheduled into **Phase 0** (pre-Build-1) and gate the first build.

### B1 — The safety taxonomy gates the wrong surface

*Raised by: Hickey, Kleppmann, Fowler, architect-reviewer, security-auditor (5 of 6 seats).*

The doc 002 §6 / §10 mutation taxonomy is the plan's load-bearing safety claim, but its enforcement
inspects only the `mcp__*` namespace — and the destructive surface reaches an agent through **two
doors**, neither fully covered:

- **Door (a): `query`/`exec` is ONE MCP tool carrying every SQL verb.** A single `query` grant lets an
  agent run `DELETE`, `CALL DOLT_RESET('--hard')`, `CALL DOLT_PUSH(...)`, `DROP` — the destructive
  surface is *inside* a tool the agent is supposed to have. Excluding history-affecting *tools* from
  the allowlist does nothing about destructive *statements* routed through an allowed one.
- **Door (b): `Bash(dolt:*)` / `Bash(bd:*)` / `Bash(bash:*)` reach the CLI directly** — `push --force`,
  `reset --hard`, `branch -D` are one coarse Bash grant away, entirely outside the MCP namespace the
  §10 gate asserts against.

The §10 gate, as written, is blind to both. **Adopted fix:**

1. **A verb-class statement classifier at the `scripts/dolt-mcp-client.py` chokepoint** — every SQL
   string is parsed for its leading verb / `CALL DOLT_*` procedure and classified read / safe-write /
   history-affecting. Anything outside read/safe-write is **rejected** unless invoked with
   `--allow-mutation --branch agent/<task>` where the branch is provably **not** `main`.
2. **Replace the coarse `Bash(dolt:*)` / `Bash(bd:*)` grants with explicit read-only subcommand
   allowlists**, eliminate `Bash(bash:*)` entirely, and add `disallowed-tools` denylists as
   defense-in-depth.
3. **Extend the §10 verification gate to assert against MCP *and* Bash** — no agent reaches a
   history-affecting operation through either door.
4. **Feed `descriptor.maturity` into the same classifier** so a pre-GA flavor's write-gating is
   enforced at the chokepoint, not merely documented.

### B2 — Three of four §6 invariants are prose-only

*Raised by: Kleppmann.*

Doc 002 §6 lists four enforcement invariants; three have **zero occurrences in the repo** —
`dolt_conflicts`-halt, DAG-ancestry ordering, and DoltHub async poll-to-terminal are asserted but
unimplemented. Worse, `scripts/dolt-push-dolthub.sh` **swallows export failure** (`… || true`) and
then pushes — a failed flush does not abort the push, exactly the silent-corruption path the taxonomy
exists to prevent. **Adopted fix:** each invariant becomes a **failing `eval.yaml` criterion paired
with a real mechanism** — not a sentence. Specifically: remove the `|| true` export-swallow so a
failed flush **aborts** the push; add a DoltHub **async poll-to-terminal** step before any retry,
guarded by an idempotency check so a re-issued write cannot double-apply.

### B3 — Build 1 reframes the skill out from under its own eval

*Raised by: Fowler.*

`eval.yaml` is bound to `skill_name: beads-dolt` with beads-first prompts — it is the strangler-fig
regression gate the whole plan leans on (doc 003 §5, Fowler's adopted contribution). But doc 002
Build 1 **reframes that very skill** in the same step, which moves the eval's subject out from under
it. **Adopted fix:** split Build 1 in two:

- **Build 1a** — extract the generic VC-surface core; **beads visibility stays PRIMARY**; the existing
  `eval.yaml` is unchanged and stays **green**.
- **Build 1b** — demote beads to an adapter **and** port the 5 test-cases into a `beads-adapter`
  `eval.yaml` **in the same commit as the reframe** — the eval moves with its subject, never behind it.

### B4 — Unpinned binary

*Raised by: Thompson, security-auditor.*

`dolt-mcp-server@latest` (in `README.md` and `scripts/dolt-mcp-client.py`, ×2) mediates **every** SQL
call the plugin makes — and the plan deferred pinning it to a *future* `dolt-watch` signal, which is
backwards: the radar would propose a bump against a binary the plugin never pinned in the first place.
**Adopted fix:** **pin `@vX.Y.Z` and record a checksum** in Build 1, **before** the rename, in all
three references. `dolt-watch`'s job becomes **verifying the pin and proposing a bump** on an upstream
release — never auto-trusting `@latest`.

### B5 — `dolt-watch` is an injection sink with write authority

*Raised by: security-auditor.*

The §7 radar parses **untrusted upstream text** (release notes, blog feed, tool-list dumps) and then
**writes repo state** — it commits `state.json` via PR and opens GitHub issues with a token — yet the
plan gives it no `permissions:` block, no input sanitization, and no rate-limit. Untrusted text
flowing into a token-bearing writer is a textbook injection sink. **Adopted fix:**

- **Least-privilege `permissions:`** — `contents: read`, `issues: write`, and a **scoped token** for
  the `state.json` PR (not the workflow's default broad token).
- **Treat all upstream text as untrusted data** — never interpolate it into a shell command or into
  `bd-sync`; **parameterize** issue/bead bodies rather than string-building them.
- **Rate-limit issue creation per run** so a noisy upstream day cannot open an unbounded issue storm.
- **`gitleaks` / `trufflehog` pre-commit** on the `state.json` PR.

### B6 — "Adapter eval before catalog" is asserted, not enforced

*Raised by: Fowler.*

The plan states an adapter ships its own `eval.yaml` before it earns a catalog entry — but nothing
**enforces** the ordering, so an adapter could land in the catalog eval-less. **Adopted fix:**
`sync-marketplace` (or a discrete CI step) **refuses** an adapter's catalog entry unless
`skills/<adapter>/eval.yaml` **exists** AND its **last run is `decision: allow`**. The assertion
becomes a gate.

---

## 3. MAJORS — fold into the revised plan

Not Phase-0-gating, but each is folded into the revised plan. Finding · seats · adopted fix:

| # | Finding | Seats | Adopted fix |
|---|---|---|---|
| M1 | The maturity gate is prose, and a maturity flip silently re-grants write authority | Hickey, Kleppmann, Fowler | Maturity is enforced **in the B1 classifier**; a `dolt-watch` maturity bump **triggers that adapter's eval as a required gate** before the descriptor PR merges — a promotion cannot silently widen write authority. |
| M2 | `dolt-operator` concentrates privilege — it merges the two `Bash(dolt:*)` agents into one | Fowler, architect-reviewer, security-auditor | Keep the capability collapse, but **split the grant tier**: `dolt-operator` gets **read/safe-write Dolt grants only**; `bd dolt killall` / mode-migration / `bd backup` stay **recommend-only** (or live in `beads-adapter`). The §9 rename includes a **grant-narrowing step**, not just a prefix rename. |
| M3 | The schema-profile seam is unspecified and is an untested injection vector | Hickey, security-auditor | **Specify the profile value format**; parameterize **one** script against it; **prove the seam** with a 2nd throwaway non-beads profile **before** claiming the inversion; **validate profiles as untrusted input** (the agent trusts live introspection over the profile). |
| M4 | `creds-ref` is under-specified | security-auditor, Hickey | **Enumerate accepted schemes** (`env:`, `sops:path#key`, `pass:path`), define **resolution order**, and **fail-closed on unresolved** (never empty-string-to-unauthenticated for a non-loopback endpoint); add a **validator rule rejecting any creds-ref without a known `scheme:` prefix**; specify the descriptor's **home** (one committed `connection.descriptor.json` per workspace) and the **descriptor→`.mcp.json`-args transform**. |
| M5 | Concurrent agent-branch lost-update | Kleppmann | **Document the concurrency invariant**: data-PR merges **serialize through `main`**; a merge producing non-empty `dolt_conflicts` **blocks the PR** and surfaces the conflict rows — **never auto-resolves**. Eval: two overlapping agent branches → halted, human-visible conflict. |
| M6 | §9 map incomplete + factual errors | architect-reviewer, Thompson | The **file-map completion** + the **"3 wired → 2 wired"** correction (cross-reference **Task A** → doc 002 §9 and doc 001 §2.1 / §3). |
| M7 | The descriptor "de-hardcodes literals / hardens `DOLT_PASSWORD`" is a strawman | Thompson, security-auditor | **Reframe doc 002 §2** to claim only **`flavor`+`maturity`-as-data** — endpoint/db/creds parameterization already ships (commit `d8b79ab`). Cross-reference **Task A** → doc 002 §2. |
| M8 | JSONL-vs-Dolt source-of-truth ambiguity | Kleppmann | **State the invariant in the core skill**: the **Dolt commit history is truth**; `issues.jsonl` is a **throttled projection**; on disagreement the **Dolt DAG wins**; **no destructive recovery without a verified `bd export` flush first**. |
| M9 | Injection coverage shrinks under the inversion | security-auditor | **Re-run the injection eval against the core skill + each of the 3 agents** (not just the legacy path) on **≥2 models**; **add the malicious-profile case** (M3). |

---

## 4. MINORS

- **dolt-watch state provenance** (Kleppmann) — `state.json` gets a **provenance stamp** (run
  timestamp + the upstream evidence URL per maturity value). A maturity promotion in a PR diff must
  carry a **matching run artifact**, not a bare field edit.
- **Stand up `dolt-watch` in skeleton form before the rename** (Fowler) — the radar currently arrives
  *after* the first irreversible move; the skeleton should exist before the rename so the maturity
  signal predates the alpha adapters that depend on it.
- **Apply DOGFOOD Finding 2 in the core `SKILL.md`** (architect-reviewer) — state root-cause + fix up
  front; do **not** gate the fix behind a diagnose-first detour.

---

## 5. Disposition

Every **BLOCKER (B1–B6)** is scheduled into **Phase 0 — pre-Build-1, gating**: the rename and Build 1
do not run until all six land. The **MAJORs (M1–M9)** and **MINORs** are folded into the revised plan
and tracked there.

This review **does not change the architecture** — one core + adapters, maturity-as-data, the
mutation verb taxonomy, and `dolt-watch` all stand. It **hardens the enforcement** (the taxonomy now
gates both the SQL-statement and Bash doors; the prose-only invariants become eval-backed mechanisms;
the binary is pinned; the radar is locked down) and **re-sequences the execution** (eval moves with
its subject; the binary is pinned and the watch skeleton stands before the irreversible rename). The
verdict was **unanimous `proceed-with-changes`** (6/6; 0 abandon, 0 proceed-clean) — the panel agreed
the bet is right and the plan is buildable once these gates are in place.
