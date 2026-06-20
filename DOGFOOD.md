# Dogfood: evaluating `beads-dolt` with the Intent Eval Platform

`beads-dolt` was run end-to-end through the Intent Eval Platform's own toolchain —
the platform's first external-adopter convergence run. This is the honest record:
what ran, what passed, and what the eval *found* (including bugs in the platform itself).

## The chain (all four stages executed)

| Stage | Tool | Result |
|---|---|---|
| 1. Deterministic gates | `audit-harness` (v1.2.2) `classify` + `conform` + `scan` | **conform 8 PASS / 1 ADVISORY** (all 5 agents, SKILL.md, .mcp.json, plugin.json); **scan 3 PASS / 3 ADVISORY** (gitleaks: no secrets; links + readme pass). Zero FAIL. |
| 2. Behavioral eval | `j-rig` `eval` with the **real DeepSeek provider** (`deepseek-v4-flash`) | **decision: block** — 28 (criterion × case) judgements, 28.6% pass, 9 blocker failures. Real ground truth, not stub. |
| 3. Kernel validation | `@intentsolutions/core` `GateResultV1Schema` | **enforced** — and it rejected the audit-harness rows (see Finding 1). |
| 4. Ship decision | `intent-rollout-gate` `decide()` | **block** — kernel-invalid rows + required gate unmatched. |

**End-to-end verdict: NO-SHIP.** The platform did its job — it ran on a real artifact and blocked it for concrete, inspectable reasons.

## Findings

### Finding 1 — Platform: audit-harness rows are not kernel-valid `gate-result/v1` (HIGH VALUE) — ✅ FIXED ([intent-audit-harness#103](https://github.com/jeremylongshore/intent-audit-harness/pull/103), merged)
audit-harness `conform`/`scan` emit a lighter envelope (`gate_id`, `result`, `policy_hash`,
`input_hash`, `timestamp`, `runner`, `commit_sha`, `metadata`). The kernel `gate-result/v1`
predicate body requires `gate_name`, `gate_version`, `gate_decision` (not `result`),
`gate_reasons`, `coverage`, `policy_ref`, `evaluated_at`. So every emitted row fails
`GateResultV1Schema`, and `intent-rollout-gate` correctly rejected the bundle. **The two ends
of the convergence don't speak the same row shape yet.** This is a real integration seam in the
platform, surfaced only by an end-to-end external-adopter run.

**Resolution:** fixed in `intent-audit-harness#103` (commit `8533a93`, merged 2026-06-20). `scripts/emit-evidence.sh`
now builds the canonical `gate-result/v1` body (`result`→`gate_decision`, `timestamp`→`evaluated_at`; synthesizes
`gate_name`/`gate_version`/`coverage`/`policy_ref`/`gate_reasons`), bringing the CLI path to parity with the
kernel-valid `ci/emit-evidence.ts` self-gate. A new full-kernel post-emit fixture + repointed regression mean the
suite now genuinely gates kernel-validity (it was masking the drift against a stale partial fixture). After the
fix: `conform | emit-evidence` → `GateResultV1Schema` 9/9 valid → rollout-gate **block → allow**.

### Finding 2 — Plugin: the skill front-loads diagnosis, not the fix (VALID)
For the canonical "my beads aren't in DoltHub" prompt, the model's one-shot response ran the
skill's Step-1 diagnostic commands (`bd dolt show`, `bd dolt remote list`) and **stopped there**
— it never reached the Step-2 fix (`bd dolt remote add` + `bd dolt push`). The judge correctly
failed `diagnoses-no-remote` / `recommends-remote-add-push`. → the SKILL.md should state the
root cause + fix up front, not gate the fix behind a "diagnose first" step a single response
truncates at.

### Finding 3 — Eval design: j-rig applies criteria as a full matrix (AUTHORING LESSON)
j-rig evaluates *every* criterion against *every* test case; it does not honor per-test-case
`criteria_ids` as a subtractive filter. So Dolt-specific criteria were judged against the
off-topic "what time zone is Atlanta" control prompt and naturally failed, inflating the failure
count. → `eval.yaml` criteria must be globally applicable, or the matrix noise must be expected.

## Reproduce

```bash
AH=…/audit-harness/bin/audit-harness.js ; JR=…/j-rig-binary-eval/packages/cli/dist/index.js
P=…/beads-dolt ; SKILL=$P/skills/beads-dolt
node $AH conform $P ; node $AH scan $P                       # stage 1
node $JR validate $SKILL/eval.yaml ; node $JR check $SKILL   # static
export DEEPSEEK_API_KEY=…  # from your secret store (e.g. a SOPS-encrypted env file)
node $JR eval $SKILL --spec $SKILL/eval.yaml --provider deepseek --models deepseek-v4-flash --db /tmp/x.db --json
# stage 3+4: wrap each conform row via `audit-harness emit-evidence`, then intent-rollout-gate decide()
```

Production-Rekor signing is intentionally NOT exercised here (it is DNSSEC/CAA-gated and
irrelevant to a local quality gate). Everything above runs locally with a DeepSeek key.
