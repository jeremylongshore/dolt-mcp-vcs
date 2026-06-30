#!/usr/bin/env node
// @ts-check
/**
 * dolt-watch — the dolt-mcp-vcs upstream radar.
 *
 * WHAT IT DOES
 *   Watches exactly ONE upstream surface — the dolt-mcp release tag plus its
 *   tool-list (plan decision 5: MINIMAL). Each run it loads the committed
 *   baseline (dolt-watch/state.json), fetches the live current state, diffs
 *   them, classifies each delta into a SIGNAL -> ACTION, and on a real delta
 *   opens up to MAX_ISSUES GitHub issues, then writes the updated state.json
 *   (the workflow opens a PR for that change).
 *
 * SECURITY POSTURE (engineering-panel blocker B5)
 *   dolt-watch is an injection sink WITH write authority: it parses UNTRUSTED
 *   upstream text (release names, tool names) and then writes repo state and
 *   opens issues with a token. Therefore EVERY upstream string is treated as
 *   untrusted DATA:
 *     - it is never interpolated into a shell command, a git command, or an
 *       issue/PR title/body without sanitizeUntrusted() first;
 *     - issue bodies are PARAMETERIZED (built from sanitized fields only);
 *     - issue creation is HARD-CAPPED per run (MAX_ISSUES);
 *     - a failed fetch THROWS — it is NEVER silently read as "everything was
 *       removed" (which would otherwise fire a storm of tool-removed deltas).
 *   The workflow grants least-privilege permissions and runs a gitleaks scan
 *   before the state-update PR; see .github/workflows/dolt-watch.yml.
 *
 * PROVENANCE (engineering-panel minor)
 *   Every tracked value in state.json carries { verifiedAt, evidenceUrl }. A
 *   maturity/version promotion in a state.json PR diff must trace to a matching
 *   run artifact (this script stamps verifiedAt + evidenceUrl when it writes),
 *   never a bare hand edit.
 *
 * RUNTIME
 *   Node ESM, Node >=20. ZERO npm dependencies — built-in global fetch,
 *   node:fs, node:path, node:url only. bd / bd-sync are NOT available in CI;
 *   the GitHub issue body carries a documented manual reverse-mirror TODO
 *   (the local three-layer bead is created by hand from the issue).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo-root-relative path to the committed baseline. */
export const STATE_PATH = resolve(__dirname, '..', 'dolt-watch', 'state.json');

/** Hard cap on issues opened per run (B5: rate-limit). */
export const MAX_ISSUES = Number(process.env.DOLT_WATCH_MAX_ISSUES || 5);

/** The one watched surface. MINIMAL — do not add more without an adapter. */
const WATCHED_KEY = 'dolt-mcp';
const DOLT_MCP_REPO = 'dolthub/dolt-mcp';
const PROXY_LATEST = 'https://proxy.golang.org/github.com/dolthub/dolt-mcp/@latest';
/** Ordered low->high; index is the comparator for a maturity bump. */
export const MATURITY_ORDER = ['experimental', 'alpha', 'beta', 'rc', 'ga'];

/**
 * Strict semver allowlist for an upstream version string. Anchored end-to-end so
 * NO path-traversal / query-smuggling payload (e.g. "v1.0.0/../../../etc/passwd?")
 * can pass — the trailing `/`, `.`, `?`, etc. are rejected by the `$` anchor.
 * Form: optional leading `v`, MAJOR.MINOR.PATCH, optional `-prerelease` (the
 * Go-module/semver pre-release: dot-separated [0-9A-Za-z-] identifiers).
 */
export const VERSION_ALLOWLIST = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Assert an upstream version string is a safe, well-formed semver tag BEFORE it
 * is interpolated into any URL/path (B5: untrusted upstream text must never
 * reach a side-effecting operation unsanitized). Throws on anything that is not
 * a strict, fully-anchored semver — which rejects path-traversal and
 * query-smuggling payloads outright.
 * @param {*} version
 * @returns {string} the validated version (unchanged on success)
 */
export function assertSafeVersion(version) {
  if (typeof version !== 'string' || !VERSION_ALLOWLIST.test(version)) {
    throw new Error(
      `fetchCurrentState: refusing untrusted version ${JSON.stringify(version)} — not a strict semver tag (B5: a crafted version could rewrite the toolset fetch path)`,
    );
  }
  return version;
}

// ---------------------------------------------------------------------------
// PURE CORE (exported, fully unit-tested) — no I/O, no network, no process.exit
// ---------------------------------------------------------------------------

/**
 * Parse a semver-ish tag ("v0.3.6", "0.3.6", "v1.0.0-rc1") into {major,minor,patch}.
 * Returns null when unparseable (caller decides how to treat that).
 * @param {string} tag
 * @returns {{major:number,minor:number,patch:number}|null}
 */
export function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Diff the previous baseline against the current fetched state.
 *
 * First-run contract: if `prev` is null/empty (no watched surface yet), emit a
 * SINGLE {kind:'baseline'} note rather than a storm of spurious tool-added /
 * maturity-bump deltas. The caller does NOT open issues for a 'baseline' note;
 * it just records the seed. Steady-state runs always have a real `prev`.
 *
 * @param {object|null} prev
 * @param {object} curr
 * @returns {Array<{kind:string,subject:string,from:*,to:*}>}
 */
export function diffState(prev, curr) {
  const deltas = [];
  const prevWatched = prev && prev.watched && prev.watched[WATCHED_KEY];
  const currWatched = curr && curr.watched && curr.watched[WATCHED_KEY];

  // First-run: no prior baseline at all.
  if (!prev || !prevWatched) {
    return [{ kind: 'baseline', subject: WATCHED_KEY, from: null, to: currWatched ? currWatched.version : null }];
  }
  if (!currWatched) {
    // Defensive: a current state missing the watched surface is a fetch/shape
    // bug, not "the product was deleted". Surface it loudly, do not emit
    // tool-removed for all 45 tools.
    throw new Error('diffState: current state is missing the watched surface; refusing to emit mass tool-removed deltas');
  }

  // --- version deltas ---
  if (prevWatched.version !== currWatched.version) {
    const a = parseVersion(prevWatched.version);
    const b = parseVersion(currWatched.version);
    const isMajor = a && b && b.major > a.major;
    deltas.push({
      kind: isMajor ? 'major-version-bump' : 'version-bump',
      subject: WATCHED_KEY,
      from: prevWatched.version,
      to: currWatched.version,
    });
  }

  // --- tool deltas (set difference, order-independent) ---
  const prevTools = new Set(Array.isArray(prevWatched.tools) ? prevWatched.tools : []);
  const currTools = new Set(Array.isArray(currWatched.tools) ? currWatched.tools : []);
  for (const t of currTools) {
    if (!prevTools.has(t)) deltas.push({ kind: 'tool-added', subject: t, from: null, to: t });
  }
  for (const t of prevTools) {
    if (!currTools.has(t)) deltas.push({ kind: 'tool-removed', subject: t, from: t, to: null });
  }

  // --- maturity deltas ---
  const prevMat = (prev && prev.maturities) || {};
  const currMat = (curr && curr.maturities) || {};
  for (const flavor of Object.keys(currMat)) {
    const before = prevMat[flavor] && prevMat[flavor].value;
    const after = currMat[flavor] && currMat[flavor].value;
    if (before !== undefined && after !== undefined && before !== after) {
      // Only treat a forward move along the known order as a "bump"; any
      // unexpected/sideways change is still surfaced (so a regression isn't
      // silently dropped) but tagged so the action prompt is honest.
      deltas.push({ kind: 'maturity-bump', subject: flavor, from: before, to: after });
    }
  }

  return deltas;
}

/**
 * Map a delta to its {signal, action, severity} per the SIGNAL->ACTION rules.
 * @param {{kind:string,subject:string,from:*,to:*}} delta
 * @returns {{signal:string,action:string,severity:'low'|'medium'|'high'|'info'}}
 */
export function classifyDelta(delta) {
  switch (delta.kind) {
    case 'tool-added':
      return {
        signal: 'new-dolt-mcp-tool',
        action: 'Review the new tool for wiring / least-privilege: decide whether to expose it through the plugin, and if so add it to the agent tools allowlist with the minimum scope it needs (treat write/exec tools as gated by the connection-descriptor maturity rule).',
        severity: 'medium',
      };
    case 'tool-removed':
      return {
        signal: 'removed-dolt-mcp-tool',
        action: 'Review the removed tool for wiring / least-privilege: confirm nothing in the plugin still references it, and prune any descriptor/agent allowlist entry that names it before the pin bump.',
        severity: 'medium',
      };
    case 'maturity-bump': {
      const fromIdx = MATURITY_ORDER.indexOf(String(delta.from));
      const toIdx = MATURITY_ORDER.indexOf(String(delta.to));
      const forward = fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx;
      return {
        signal: 'product-maturity-bump',
        action: `Promote the descriptor maturity field for "${delta.subject}" (${delta.from} -> ${delta.to}), run that adapter's eval as a required gate, and build the adapter — it was a descriptor-stub. ${forward ? '' : 'NOTE: this is NOT a forward promotion along experimental->alpha->beta->rc->ga; verify upstream before changing the gate (a regression must tighten, not loosen, the mutation gate).'}`.trim(),
        severity: forward ? 'high' : 'medium',
      };
    }
    case 'major-version-bump':
      return {
        signal: 'major-version-bump',
        action: 'Re-verify the version-control SQL surface against the new major, then PROPOSE a dolt-mcp pin bump as a PR (never auto-trust @latest, per blocker B4). The pin only advances after the eval gate passes on the new major.',
        severity: 'high',
      };
    case 'version-bump':
      return {
        signal: 'version-bump',
        action: 'Re-verify the version-control SQL surface, then PROPOSE a dolt-mcp pin bump as a PR (never auto-trust @latest, per blocker B4).',
        severity: 'medium',
      };
    case 'baseline':
      return {
        signal: 'baseline-seed',
        action: 'First run: recording the baseline. No action — subsequent runs diff against it.',
        severity: 'info',
      };
    default:
      return {
        signal: 'unknown-delta',
        action: `Unrecognized delta kind "${delta.kind}". Triage manually.`,
        severity: 'medium',
      };
  }
}

/**
 * sanitizeUntrusted — the B5 core. Make an upstream string safe to embed in a
 * GitHub issue title/body (which is rendered Markdown, and whose contents could
 * otherwise be smuggled into a downstream shell/git command).
 *
 * Strategy (strict, allowlist-leaning):
 *   1. Coerce non-strings to '' (never throw on bad input).
 *   2. Strip ALL ASCII control chars (C0 0x00-0x1F, DEL 0x7F) and the C1 range
 *      (0x80-0x9F) — kills newlines, NULs, ANSI, etc. that break out of a field.
 *   3. Strip Unicode bidi-override / format chars (CVE-2021-42574 Trojan Source
 *      class) and zero-width chars that hide payloads.
 *   4. Neutralize command-substitution sequences: $( ), ` `, ${ }, and shell
 *      metacharacters that matter if the value ever reaches a shell despite our
 *      parameterized design (defense in depth) — backticks become quotes,
 *      $(/${/| /; /& /> /< /\ are escaped to a visible, inert token.
 *      Note: bare unmatched '$' is left as-is (it is harmless text); only the
 *      substitution-forming sequences are neutralized.
 *   5. Neutralize Markdown/HTML injection: HTML comments <!-- -->, raw < and >
 *      (so no tag/comment smuggling), and @mentions (\b@name -> @​ is NOT
 *      used; we prefix with a zero-width-free marker by inserting a backtick
 *      fence-safe replacement) — @ at a mention boundary becomes "@-" guarded.
 *   6. Collapse whitespace runs and hard-cap length (default 200) with an
 *      explicit ellipsis so an attacker can't pad a body to exhaust the API.
 *
 * The result is plain, single-line, length-bounded text with no active
 * Markdown, no HTML, no shell-substitution, and no mention pings.
 *
 * @param {*} text
 * @param {number} [maxLen=200]
 * @returns {string}
 */
export function sanitizeUntrusted(text, maxLen = 200) {
  if (typeof text !== 'string') return '';
  let s = text;

  // 2. ASCII C0 + DEL + C1 control chars -> drop.
  s = s.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

  // 3. Bidi overrides / directional formatting + zero-width + BOM/format chars.
  //    U+200B-200F (zero-width + LRM/RLM), U+202A-202E (embeddings/overrides),
  //    U+2066-2069 (isolates), U+FEFF (BOM), U+2060 (word joiner).
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '');

  // 4. Command-substitution / shell metacharacter neutralization (defense in
  //    depth; bodies are parameterized so this should never reach a shell, but
  //    we make the value inert anyway).
  s = s.replace(/\$\(/g, '$․('); // $( -> $․(  (one-dot leader, not a paren-trigger)
  s = s.replace(/\$\{/g, '$․{'); // ${ -> $․{
  s = s.replace(/`/g, "'");            // backticks -> single quotes (kills code spans + cmd subst)
  s = s.replace(/[|;&><\\]/g, ' ');    // pipe/semicolon/amp/redirect/backslash -> space

  // 5. Markdown / HTML injection neutralization.
  s = s.replace(/<!--/g, '(!--').replace(/-->/g, '--)'); // defang HTML comments
  s = s.replace(/[<>]/g, ' ');                            // strip any remaining raw angle brackets
  //    @mention defang: break the mention boundary so GitHub doesn't ping.
  //    "@octocat" -> "@​" is itself a zero-width insertion we just stripped,
  //    so instead insert an inert visible separator after a leading @.
  s = s.replace(/@(?=[A-Za-z0-9_-])/g, '@․'); // @ -> @․ (one-dot leader breaks the mention)

  // 6. Collapse whitespace, trim, hard cap length.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) {
    s = s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…'; // ellipsis
  }
  return s;
}

/**
 * renderIssue — build the {title, body} for a delta. EVERY upstream-derived
 * field passes through sanitizeUntrusted first; nothing raw reaches the output.
 * Body is assembled from a fixed template + sanitized values (parameterized).
 *
 * @param {{kind:string,subject:string,from:*,to:*}} delta
 * @param {{signal:string,action:string,severity:string}} classified
 * @returns {{title:string,body:string}}
 */
export function renderIssue(delta, classified) {
  const subject = sanitizeUntrusted(String(delta.subject ?? ''), 80);
  const from = sanitizeUntrusted(String(delta.from ?? ''), 60);
  const to = sanitizeUntrusted(String(delta.to ?? ''), 60);
  // kind/signal/severity/action are TRUSTED (we generate them), but we still
  // bound their length to be safe.
  const kind = sanitizeUntrusted(String(delta.kind ?? ''), 40);
  const signal = sanitizeUntrusted(String(classified.signal ?? ''), 60);
  const severity = sanitizeUntrusted(String(classified.severity ?? ''), 16);
  const action = sanitizeUntrusted(String(classified.action ?? ''), 600);

  const title = `[dolt-watch] ${kind}: ${subject}`.slice(0, 240);

  const body = [
    `**dolt-watch upstream radar** detected a change in the watched surface (\`dolt-mcp\`).`,
    '',
    '| field | value |',
    '| --- | --- |',
    `| kind | \`${kind}\` |`,
    `| subject | ${subject || '(none)'} |`,
    `| from | ${from || '(none)'} |`,
    `| to | ${to || '(none)'} |`,
    `| signal | \`${signal}\` |`,
    `| severity | \`${severity}\` |`,
    '',
    '### Action',
    '',
    action,
    '',
    '---',
    '',
    '### Reverse-mirror TODO (manual — CI cannot run bd / bd-sync)',
    '',
    'This issue was opened by a GitHub Actions run where `bd` is unavailable. To',
    'complete the three-layer mirror, a maintainer must, locally:',
    '',
    '1. `bd create` a bead describing this action (plain-English imperative title).',
    `2. \`bd-sync link <bead> --gh ${sanitizeUntrusted(process.env.GITHUB_REPOSITORY || 'jeremylongshore/dolt-mcp-vcs', 80)}#<this-issue-number>\``,
    '3. Work the action, then `bd-sync close <bead> --reason "..."` to fan the close back out.',
    '',
    '_All upstream-derived text above was sanitized (control chars stripped, length',
    'capped, command-substitution / Markdown / @-mentions neutralized) before',
    'embedding — per blocker B5._',
  ].join('\n');

  return { title, body };
}

// ---------------------------------------------------------------------------
// I/O LAYER (network + filesystem + GitHub REST) — not unit-tested directly
// ---------------------------------------------------------------------------

/**
 * Load the committed baseline. Returns the parsed object, or null if the file
 * is absent (first-run). A malformed file THROWS — we never silently treat a
 * corrupt baseline as "empty" (that would fire spurious deltas).
 * @returns {object|null}
 */
export function loadState(path = STATE_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * Fetch the dolt-mcp latest tag + tool list and return a state-shaped object.
 * Tolerates nothing silently: any network/HTTP/parse failure THROWS with a
 * clear message. NEVER returns an empty tool list on failure (which diffState
 * would read as a mass tool-removed).
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {string} [opts.toolsetUrl] override the toolset registry URL
 * @returns {Promise<object>} state-shaped { watched: { 'dolt-mcp': {...} }, maturities }
 */
export async function fetchCurrentState(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('fetchCurrentState: global fetch is unavailable (need Node >=20)');
  }

  // 1. latest tag
  let version;
  {
    const res = await doFetch(PROXY_LATEST, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`fetchCurrentState: latest-tag fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json.Version !== 'string' || !json.Version) {
      throw new Error('fetchCurrentState: latest-tag response missing .Version');
    }
    // B5: `Version` is untrusted upstream/MITM-influenceable text and is about
    // to be interpolated into the toolset fetch URL path. Validate against a
    // strict, fully-anchored semver allowlist BEFORE it reaches the URL — this
    // rejects path-traversal / query-smuggling payloads outright.
    version = assertSafeVersion(json.Version);
  }

  // 2. tool list, read from the pinned-version toolset registry source.
  //    encodeURIComponent() on the version segment is defense-in-depth (the
  //    semver allowlist above is the real guard); together they ensure no
  //    upstream-supplied character can steer the fetch path.
  const toolsetUrl =
    opts.toolsetUrl ||
    `https://raw.githubusercontent.com/${DOLT_MCP_REPO}/${encodeURIComponent(version)}/mcp/pkg/toolsets/primitive_v1.go`;
  let tools;
  {
    const res = await doFetch(toolsetUrl, { headers: { accept: 'text/plain' } });
    if (!res.ok) throw new Error(`fetchCurrentState: toolset fetch failed: HTTP ${res.status} (${toolsetUrl})`);
    const src = await res.text();
    tools = parseToolNames(src);
    if (tools.length === 0) {
      // A registry that parses to zero tools is a parse/shape failure, not a
      // real "all tools removed". Refuse rather than emit a removal storm.
      throw new Error('fetchCurrentState: parsed zero tools from the toolset registry — refusing (likely a source-layout change upstream)');
    }
  }

  const now = new Date().toISOString();
  return {
    watched: {
      [WATCHED_KEY]: {
        repo: DOLT_MCP_REPO,
        version,
        tools,
        evidenceUrl: toolsetUrl,
        verifiedAt: now,
      },
    },
    // Maturities are not machine-fetchable from a single canonical endpoint;
    // they are carried forward from the baseline and only changed by a human
    // (with provenance) — fetchCurrentState leaves them to the caller to merge.
    maturities: {},
  };
}

/**
 * Extract the registered MCP tool-name strings from the primitive_v1 toolset
 * source. Matches the `tools.XxxToolName` registry entries and converts the
 * CamelCase constant to the snake_case tool string the server registers.
 * @param {string} src
 * @returns {string[]} ordered, de-duplicated
 */
export function parseToolNames(src) {
  if (typeof src !== 'string') return [];
  const consts = [...src.matchAll(/tools\.([A-Za-z]+)ToolName\b/g)].map((m) => m[1]);
  const overrides = { MergeDoltBranchNoFastForward: 'merge_dolt_branch_no_ff' };
  const seen = new Set();
  const out = [];
  for (const c of consts) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(overrides[c] || c.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase());
  }
  return out;
}

/**
 * Merge a freshly-fetched state with the prior baseline so the WRITTEN state
 * carries forward maturities (human-owned, with provenance) and re-stamps the
 * watched surface's provenance. The fetched watched surface wins; maturities
 * come from prev unless prev is null.
 * @param {object|null} prev
 * @param {object} fetched
 * @returns {object}
 */
export function mergeForWrite(prev, fetched) {
  const base = prev ? structuredClone(prev) : { schemaVersion: '1.0.0', watched: {}, maturities: {} };
  base.watched = base.watched || {};
  base.watched[WATCHED_KEY] = fetched.watched[WATCHED_KEY];
  base.maturities = base.maturities || {};
  return base;
}

/**
 * Open a GitHub issue via the REST API. Idempotent: skips creation if an OPEN
 * issue with the identical title already exists. Returns 'created' | 'skipped'.
 * @param {{title:string,body:string}} issue
 * @param {object} ctx { token, repo (owner/name), fetchImpl }
 * @returns {Promise<'created'|'skipped'>}
 */
export async function openIssue(issue, ctx) {
  const doFetch = ctx.fetchImpl || globalThis.fetch;
  const repo = ctx.repo;
  const token = ctx.token;
  if (!token) throw new Error('openIssue: missing GitHub token');
  if (!repo) throw new Error('openIssue: missing repo (owner/name)');

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'dolt-watch',
  };

  // Idempotency: search open issues by exact title.
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${issue.title}"`);
  const searchRes = await doFetch(`https://api.github.com/search/issues?q=${q}`, { headers });
  if (searchRes.ok) {
    const found = await searchRes.json();
    if (found && Array.isArray(found.items) && found.items.some((i) => i.title === issue.title)) {
      return 'skipped';
    }
  }
  // (a non-ok search is non-fatal; we fall through and attempt creation, which
  // is still bounded by MAX_ISSUES)

  const createRes = await doFetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: issue.title, body: issue.body, labels: ['dolt-watch', 'upstream-radar'] }),
  });
  if (!createRes.ok) {
    const detail = await createRes.text().catch(() => '');
    throw new Error(`openIssue: create failed HTTP ${createRes.status}: ${detail.slice(0, 200)}`);
  }
  return 'created';
}

/**
 * Write the updated baseline to disk (the workflow opens the PR).
 * @param {object} state
 */
export function writeState(state, path = STATE_PATH) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// ENTRYPOINT
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run') || argv.includes('--check');
  const repo = process.env.GITHUB_REPOSITORY || 'jeremylongshore/dolt-mcp-vcs';
  const token = process.env.GITHUB_TOKEN;

  const prev = loadState();

  let fetched;
  try {
    fetched = await fetchCurrentState();
  } catch (err) {
    console.error(`dolt-watch: FETCH FAILED — ${err && err.message}`);
    console.error('dolt-watch: a failed fetch is NEVER treated as "everything removed". Exiting non-zero without writing state or opening issues.');
    return 2;
  }

  // diffState reads maturities from both objects; carry prev's maturities into
  // the fetched object so a maturity change (human-edited in a prior PR) is not
  // spuriously flagged, and tool/version deltas compute against prev.
  const currForDiff = { ...fetched, maturities: (prev && prev.maturities) || {} };
  const deltas = diffState(prev, currForDiff);

  // First-run baseline note: record the seed, no issues.
  const isFirstRun = deltas.length === 1 && deltas[0].kind === 'baseline';

  if (deltas.length === 0) {
    console.log('dolt-watch: no deltas. Baseline is current.');
    return 0;
  }

  const report = deltas.map((d) => ({ delta: d, classified: classifyDelta(d) }));
  for (const { delta, classified } of report) {
    console.log(`dolt-watch: [${classified.severity}] ${delta.kind} ${delta.subject} (${delta.from} -> ${delta.to}) => ${classified.signal}`);
  }

  if (dryRun) {
    console.log(`dolt-watch: --dry-run/--check — ${deltas.length} delta(s) printed; no issues opened, state not written.`);
    return 0;
  }

  // Open issues (capped), skipping the baseline note. Then write state.
  if (!isFirstRun) {
    let opened = 0;
    if (!token) {
      console.error('dolt-watch: GITHUB_TOKEN not set — cannot open issues. State will still be written.');
    } else {
      for (const { delta, classified } of report) {
        if (delta.kind === 'baseline') continue;
        if (opened >= MAX_ISSUES) {
          console.warn(`dolt-watch: MAX_ISSUES (${MAX_ISSUES}) reached — ${report.length - opened} delta(s) deferred to the next run.`);
          break;
        }
        const issue = renderIssue(delta, classified);
        try {
          const result = await openIssue(issue, { token, repo });
          console.log(`dolt-watch: issue ${result}: ${issue.title}`);
          if (result === 'created') opened += 1;
        } catch (err) {
          console.error(`dolt-watch: failed to open issue for ${delta.kind} ${delta.subject}: ${err && err.message}`);
        }
      }
    }
  }

  // Always write the refreshed baseline (re-stamped provenance) so the next run
  // diffs against current truth. The workflow gitleaks-scans + opens the PR.
  const toWrite = mergeForWrite(prev, fetched);
  writeState(toWrite);
  console.log(`dolt-watch: wrote refreshed baseline to ${STATE_PATH}`);
  return 0;
}

// Run only when invoked directly (not when imported by the test file).
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('dolt-watch: UNHANDLED ERROR', err);
      process.exit(1);
    });
}
