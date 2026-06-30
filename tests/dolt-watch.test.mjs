// node:test suite for dolt-watch's PURE core + rate-limit cap.
// Run: node --test tests/dolt-watch.test.mjs
// ZERO npm deps — node:test + node:assert/strict only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffState,
  classifyDelta,
  sanitizeUntrusted,
  renderIssue,
  parseVersion,
  parseToolNames,
  openIssue,
  fetchCurrentState,
  assertSafeVersion,
  VERSION_ALLOWLIST,
  MATURITY_ORDER,
} from '../scripts/dolt-watch.mjs';

// --- fixtures ---------------------------------------------------------------

const BASE_TOOLS = ['query', 'exec', 'create_dolt_commit', 'list_dolt_branches'];

function stateWith({ version = 'v0.3.6', tools = BASE_TOOLS, maturities } = {}) {
  return {
    schemaVersion: '1.0.0',
    watched: {
      'dolt-mcp': {
        repo: 'dolthub/dolt-mcp',
        version,
        tools: [...tools],
        evidenceUrl: 'https://example.test/evidence',
        verifiedAt: '2026-06-30T00:00:00Z',
      },
    },
    maturities: maturities || {
      dolt: { value: 'ga', evidenceUrl: 'u', verifiedAt: 't' },
      doltlite: { value: 'alpha', evidenceUrl: 'u', verifiedAt: 't' },
      dumbo: { value: 'experimental', evidenceUrl: 'u', verifiedAt: 't' },
    },
  };
}

// --- parseVersion -----------------------------------------------------------

test('parseVersion handles v-prefixed, bare, and pre-release; rejects garbage', () => {
  assert.deepEqual(parseVersion('v0.3.6'), { major: 0, minor: 3, patch: 6 });
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('v2.0.0-rc1'), { major: 2, minor: 0, patch: 0 });
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(parseVersion(undefined), null);
});

// --- assertSafeVersion / VERSION_ALLOWLIST (B5: URL-path injection guard) ---

test('assertSafeVersion: accepts well-formed semver tags (v-prefixed, bare, pre-release)', () => {
  assert.equal(assertSafeVersion('v0.3.6'), 'v0.3.6');
  assert.equal(assertSafeVersion('1.2.3'), '1.2.3');
  assert.equal(assertSafeVersion('v2.0.0-rc1'), 'v2.0.0-rc1');
  assert.equal(assertSafeVersion('v1.0.0-alpha.1'), 'v1.0.0-alpha.1');
});

test('assertSafeVersion: rejects path-traversal / query-smuggling / control payloads', () => {
  // The exact payload from the adversarial finding — must throw, not rewrite a URL.
  assert.throws(() => assertSafeVersion('v1.0.0/../../../../etc/passwd?'), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion('v1.0.0/../../foo'), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion('v1.0.0?x=1'), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion('v1.0.0#frag'), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion('v1.0.0 '), /refusing untrusted version/); // trailing space
  assert.throws(() => assertSafeVersion('../etc/passwd'), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion('latest'), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion(''), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion(null), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion(undefined), /refusing untrusted version/);
  assert.throws(() => assertSafeVersion(123), /refusing untrusted version/);
});

test('VERSION_ALLOWLIST is fully anchored (no traversal char can pass)', () => {
  assert.ok(VERSION_ALLOWLIST.test('v0.3.6'));
  assert.ok(!VERSION_ALLOWLIST.test('v0.3.6/x'));
  assert.ok(!VERSION_ALLOWLIST.test('x/v0.3.6'));
});

test('fetchCurrentState: a crafted upstream .Version is rejected BEFORE the toolset fetch (no URL steering)', async () => {
  let toolsetFetched = false;
  const stubFetch = async (url) => {
    if (String(url).includes('@latest')) {
      return { ok: true, json: async () => ({ Version: 'v1.0.0/../../../../etc/passwd?' }) };
    }
    // If we ever reach here, the malicious version steered a real fetch.
    toolsetFetched = true;
    return { ok: true, text: async () => '' };
  };
  await assert.rejects(() => fetchCurrentState({ fetchImpl: stubFetch }), /refusing untrusted version/);
  assert.equal(toolsetFetched, false, 'the toolset fetch must NEVER fire on a crafted version');
});

test('fetchCurrentState: a valid version drives a normal toolset fetch and returns parsed state', async () => {
  const toolsetSrc = `
    {tools.QueryToolName, tools.RegisterQueryTool},
    {tools.ExecToolName, tools.RegisterExecTool},`;
  let toolsetUrlSeen = '';
  const stubFetch = async (url) => {
    if (String(url).includes('@latest')) {
      return { ok: true, json: async () => ({ Version: 'v0.4.0' }) };
    }
    toolsetUrlSeen = String(url);
    return { ok: true, text: async () => toolsetSrc };
  };
  const state = await fetchCurrentState({ fetchImpl: stubFetch });
  assert.equal(state.watched['dolt-mcp'].version, 'v0.4.0');
  assert.deepEqual(state.watched['dolt-mcp'].tools, ['query', 'exec']);
  // The validated version lands in the path, unescaped because it is plain semver.
  assert.match(toolsetUrlSeen, /\/dolthub\/dolt-mcp\/v0\.4\.0\/mcp\/pkg\/toolsets\/primitive_v1\.go$/);
});

// --- diffState --------------------------------------------------------------

test('diffState: first run (prev null) yields a single baseline note, no spurious deltas', () => {
  const curr = stateWith();
  const deltas = diffState(null, curr);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].kind, 'baseline');
  assert.equal(deltas[0].to, 'v0.3.6');
});

test('diffState: first run when prev exists but lacks the watched surface is also baseline', () => {
  const deltas = diffState({ schemaVersion: '1.0.0', watched: {}, maturities: {} }, stateWith());
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].kind, 'baseline');
});

test('diffState: identical states produce zero deltas', () => {
  const deltas = diffState(stateWith(), stateWith());
  assert.equal(deltas.length, 0);
});

test('diffState: tool added', () => {
  const prev = stateWith();
  const curr = stateWith({ tools: [...BASE_TOOLS, 'merge_dolt_branch_no_ff'] });
  const deltas = diffState(prev, curr);
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0], { kind: 'tool-added', subject: 'merge_dolt_branch_no_ff', from: null, to: 'merge_dolt_branch_no_ff' });
});

test('diffState: tool removed', () => {
  const prev = stateWith();
  const curr = stateWith({ tools: BASE_TOOLS.filter((t) => t !== 'exec') });
  const deltas = diffState(prev, curr);
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0], { kind: 'tool-removed', subject: 'exec', from: 'exec', to: null });
});

test('diffState: tool diff is order-independent (reordering yields no delta)', () => {
  const prev = stateWith({ tools: ['a', 'b', 'c'] });
  const curr = stateWith({ tools: ['c', 'a', 'b'] });
  assert.equal(diffState(prev, curr).length, 0);
});

test('diffState: minor/patch version bump is version-bump (not major)', () => {
  const deltas = diffState(stateWith({ version: 'v0.3.6' }), stateWith({ version: 'v0.4.0' }));
  const v = deltas.find((d) => d.kind.endsWith('version-bump'));
  assert.equal(v.kind, 'version-bump');
  assert.equal(v.from, 'v0.3.6');
  assert.equal(v.to, 'v0.4.0');
});

test('diffState: MAJOR version bump is major-version-bump', () => {
  const deltas = diffState(stateWith({ version: 'v0.9.9' }), stateWith({ version: 'v1.0.0' }));
  const v = deltas.find((d) => d.kind.endsWith('version-bump'));
  assert.equal(v.kind, 'major-version-bump');
});

test('diffState: maturity bump alpha->beta', () => {
  const prev = stateWith();
  const curr = stateWith();
  // mutate doltlite alpha -> beta on the "curr" maturities
  curr.maturities = JSON.parse(JSON.stringify(prev.maturities));
  curr.maturities.doltlite.value = 'beta';
  const deltas = diffState(prev, curr);
  assert.equal(deltas.length, 1);
  assert.deepEqual(
    { kind: deltas[0].kind, subject: deltas[0].subject, from: deltas[0].from, to: deltas[0].to },
    { kind: 'maturity-bump', subject: 'doltlite', from: 'alpha', to: 'beta' },
  );
});

test('diffState: a current state missing the watched surface THROWS (no mass tool-removed)', () => {
  const prev = stateWith();
  const broken = { schemaVersion: '1.0.0', watched: {}, maturities: prev.maturities };
  assert.throws(() => diffState(prev, broken), /missing the watched surface/);
});

test('diffState: combined deltas (version + tool add + tool remove + maturity) all surface', () => {
  const prev = stateWith({ version: 'v0.3.6', tools: ['query', 'exec'] });
  const curr = stateWith({ version: 'v1.0.0', tools: ['query', 'new_tool'] });
  curr.maturities = JSON.parse(JSON.stringify(prev.maturities));
  curr.maturities.dumbo.value = 'alpha';
  const kinds = diffState(prev, curr).map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['major-version-bump', 'maturity-bump', 'tool-added', 'tool-removed'].sort());
});

// --- classifyDelta ----------------------------------------------------------

test('classifyDelta: tool-added -> new-dolt-mcp-tool / least-privilege review', () => {
  const c = classifyDelta({ kind: 'tool-added', subject: 'new_tool', from: null, to: 'new_tool' });
  assert.equal(c.signal, 'new-dolt-mcp-tool');
  assert.match(c.action, /least-privilege/i);
});

test('classifyDelta: tool-removed -> removed-dolt-mcp-tool / least-privilege review', () => {
  const c = classifyDelta({ kind: 'tool-removed', subject: 'exec', from: 'exec', to: null });
  assert.equal(c.signal, 'removed-dolt-mcp-tool');
  assert.match(c.action, /least-privilege/i);
});

test('classifyDelta: forward maturity-bump -> product-maturity-bump, high severity, mentions adapter + eval', () => {
  const c = classifyDelta({ kind: 'maturity-bump', subject: 'doltlite', from: 'alpha', to: 'beta' });
  assert.equal(c.signal, 'product-maturity-bump');
  assert.equal(c.severity, 'high');
  assert.match(c.action, /eval/i);
  assert.match(c.action, /adapter/i);
});

test('classifyDelta: a non-forward maturity change is still surfaced but flagged (not high)', () => {
  const c = classifyDelta({ kind: 'maturity-bump', subject: 'doltlite', from: 'ga', to: 'beta' });
  assert.equal(c.signal, 'product-maturity-bump');
  assert.notEqual(c.severity, 'high');
  assert.match(c.action, /regression|NOT a forward/i);
});

test('classifyDelta: major-version-bump -> re-verify SQL surface + propose a PR (never auto-trust)', () => {
  const c = classifyDelta({ kind: 'major-version-bump', subject: 'dolt-mcp', from: 'v0.9.9', to: 'v1.0.0' });
  assert.equal(c.signal, 'major-version-bump');
  assert.match(c.action, /PROPOSE a dolt-mcp pin bump|PR/);
  assert.match(c.action, /never auto-trust/i);
  assert.equal(c.severity, 'high');
});

test('classifyDelta: version-bump -> propose a PR (never auto-trust)', () => {
  const c = classifyDelta({ kind: 'version-bump', subject: 'dolt-mcp', from: 'v0.3.6', to: 'v0.4.0' });
  assert.equal(c.signal, 'version-bump');
  assert.match(c.action, /never auto-trust/i);
});

test('MATURITY_ORDER is the canonical low->high ladder', () => {
  assert.deepEqual(MATURITY_ORDER, ['experimental', 'alpha', 'beta', 'rc', 'ga']);
});

// --- sanitizeUntrusted (THE B5 CORE) ---------------------------------------

test('sanitizeUntrusted: non-string coerces to empty string, never throws', () => {
  assert.equal(sanitizeUntrusted(null), '');
  assert.equal(sanitizeUntrusted(undefined), '');
  assert.equal(sanitizeUntrusted(42), '');
  assert.equal(sanitizeUntrusted({}), '');
});

test('sanitizeUntrusted: neutralizes a crafted injection payload', () => {
  // A payload combining: command substitution, backticks, an @mention, an HTML
  // comment, control chars (newline + NUL + ESC), and a shell pipe.
  const payload =
    'evil`whoami`$(rm -rf /)${HOME} @octocat <!-- hidden --> <script> | cat /etc/passwd\n\x00\x1b[31m';
  const out = sanitizeUntrusted(payload, 500);

  // No raw backticks.
  assert.ok(!out.includes('`'), 'backticks must be gone');
  // No live command-substitution opener.
  assert.ok(!out.includes('$('), '$( must be defanged');
  assert.ok(!out.includes('${'), '${ must be defanged');
  // No live @mention boundary: '@octocat' must not survive verbatim.
  assert.ok(!/@octocat\b/.test(out), '@mention must be broken');
  assert.ok(out.includes('@'), 'the @ is kept but neutralized with a separator');
  // No live HTML comment, no raw angle brackets.
  assert.ok(!out.includes('<!--'), 'HTML comment opener must be defanged');
  assert.ok(!out.includes('-->'), 'HTML comment closer must be defanged');
  assert.ok(!out.includes('<'), 'raw < must be stripped');
  assert.ok(!out.includes('>'), 'raw > must be stripped');
  // No control chars at all (NUL, newline, ESC).
  assert.ok(!/[\x00-\x1F\x7F-\x9F]/.test(out), 'all control chars must be stripped');
  // No shell pipe metacharacter.
  assert.ok(!out.includes('|'), 'pipe must be removed');
  // No backslash.
  assert.ok(!out.includes('\\'), 'backslash must be removed');
});

test('sanitizeUntrusted: strips bidi-override (Trojan Source) and zero-width chars', () => {
  // U+202E (RLO), U+200B (ZWSP), U+FEFF (BOM)
  const payload = 'safe‮order​hidden﻿end';
  const out = sanitizeUntrusted(payload);
  assert.ok(!/[​-‏‪-‮⁠⁦-⁩﻿]/.test(out), 'no bidi/zero-width survivors');
  assert.equal(out, 'safeorderhiddenend');
});

test('sanitizeUntrusted: hard length cap with ellipsis', () => {
  const out = sanitizeUntrusted('a'.repeat(1000), 50);
  assert.ok(out.length <= 50, `length ${out.length} must be <= 50`);
  assert.ok(out.endsWith('…'), 'capped output ends with an ellipsis');
});

test('sanitizeUntrusted: collapses whitespace runs to single spaces', () => {
  assert.equal(sanitizeUntrusted('a\t\t  b     c'), 'a b c');
});

test('sanitizeUntrusted: benign text is preserved', () => {
  assert.equal(sanitizeUntrusted('create_dolt_commit'), 'create_dolt_commit');
  assert.equal(sanitizeUntrusted('v0.4.0'), 'v0.4.0');
});

// --- renderIssue ------------------------------------------------------------

test('renderIssue: no raw untrusted text leaks into title or body', () => {
  const delta = {
    kind: 'tool-added',
    subject: 'tool`whoami`$(id)@octocat<!--x-->',
    from: null,
    to: 'tool`whoami`$(id)@octocat<!--x-->',
  };
  const { title, body } = renderIssue(delta, classifyDelta(delta));
  for (const text of [title, body]) {
    assert.ok(!text.includes('`whoami`'), 'no live backtick code span');
    assert.ok(!text.includes('$(id)'), 'no live command substitution');
    assert.ok(!text.includes('@octocat'), 'no live @mention');
    assert.ok(!text.includes('<!--x-->'), 'no live HTML comment');
  }
  // Title is bounded.
  assert.ok(title.length <= 240, 'title is length-bounded');
  // Body carries the reverse-mirror TODO (bd unavailable in CI).
  assert.match(body, /Reverse-mirror TODO/);
  assert.match(body, /bd-sync/);
});

test('renderIssue: title is built from the trusted kind + sanitized subject', () => {
  const delta = { kind: 'version-bump', subject: 'dolt-mcp', from: 'v0.3.6', to: 'v0.4.0' };
  const { title, body } = renderIssue(delta, classifyDelta(delta));
  assert.match(title, /^\[dolt-watch\] version-bump: dolt-mcp$/);
  // from/to values appear sanitized in the body table.
  assert.match(body, /v0\.3\.6/);
  assert.match(body, /v0\.4\.0/);
});

// --- parseToolNames ---------------------------------------------------------

test('parseToolNames: extracts snake_case names from a toolset registry snippet, honoring the no_ff override', () => {
  const src = `
    var toolset = []entry{
      {tools.CreateDoltCommitToolName, tools.RegisterCreateDoltCommitTool},
      {tools.MergeDoltBranchNoFastForwardToolName, tools.RegisterMergeDoltBranchNoFastForwardTool},
      {tools.QueryToolName, tools.RegisterQueryTool},
      {tools.QueryToolName, tools.RegisterQueryTool},
    }`;
  const names = parseToolNames(src);
  assert.deepEqual(names, ['create_dolt_commit', 'merge_dolt_branch_no_ff', 'query']); // deduped + override
});

test('parseToolNames: non-string returns empty', () => {
  assert.deepEqual(parseToolNames(null), []);
});

// --- rate-limit cap (MAX_ISSUES) -------------------------------------------
// We exercise the cap by driving the same loop main() uses: classify N deltas,
// render each, and call openIssue with a stub fetch — asserting that no more
// than the cap are "created" and that idempotency skips a same-title issue.

test('rate-limit: openIssue is idempotent — an existing open same-title issue is skipped', async () => {
  const delta = { kind: 'tool-added', subject: 'new_tool', from: null, to: 'new_tool' };
  const { title } = renderIssue(delta, classifyDelta(delta));
  const stubFetch = async (url) => {
    if (String(url).includes('/search/issues')) {
      return { ok: true, json: async () => ({ items: [{ title }] }) };
    }
    throw new Error('should not POST when an open same-title issue exists');
  };
  const result = await openIssue(renderIssue(delta, classifyDelta(delta)), {
    token: 'x',
    repo: 'owner/repo',
    fetchImpl: stubFetch,
  });
  assert.equal(result, 'skipped');
});

test('rate-limit: the per-run cap stops creation at MAX_ISSUES (cap-loop semantics)', async () => {
  // Simulate the main() cap loop in isolation against a stub that always
  // reports "no existing issue" so every attempt would otherwise create.
  const MAX = 5;
  let created = 0;
  const stubFetch = async (url, opts) => {
    if (String(url).includes('/search/issues')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    if (opts && opts.method === 'POST') {
      created += 1;
      return { ok: true, json: async () => ({ number: created }) };
    }
    throw new Error('unexpected fetch');
  };

  // 8 distinct deltas, cap at 5.
  const deltas = Array.from({ length: 8 }, (_, i) => ({
    kind: 'tool-added',
    subject: `tool_${i}`,
    from: null,
    to: `tool_${i}`,
  }));

  let opened = 0;
  for (const d of deltas) {
    if (opened >= MAX) break; // <-- the cap, mirroring main()
    const r = await openIssue(renderIssue(d, classifyDelta(d)), {
      token: 'x',
      repo: 'owner/repo',
      fetchImpl: stubFetch,
    });
    if (r === 'created') opened += 1;
  }

  assert.equal(opened, MAX, 'exactly MAX issues opened');
  assert.equal(created, MAX, 'exactly MAX POSTs reached the API');
});

test('openIssue: missing token or repo throws (fail-closed)', async () => {
  await assert.rejects(() => openIssue({ title: 't', body: 'b' }, { repo: 'o/r', fetchImpl: async () => ({}) }), /missing GitHub token/);
  await assert.rejects(() => openIssue({ title: 't', body: 'b' }, { token: 'x', fetchImpl: async () => ({}) }), /missing repo/);
});
