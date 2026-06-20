# Beads (`bd`) Dolt Backend Internals — Source-Cited Reference

**Subject:** the `bd` task-tracker's Dolt storage engine, reverse-engineered from Go source.
**Pinned to:** `bd version 1.0.4 (ce242a879)` — the [beads](https://github.com/gastownhall/beads) Go source (module path `github.com/steveyegge/beads`).
**Toolchain reference:** `bd 1.0.4` with `dolt version 1.83.1`.

Every claim below is tied to a `file.go:func`/line or a doc citation. Where the source contradicts a common belief, it is called out explicitly. **This document is ground truth for plugin agents — cite it, don't paraphrase from memory.**

---

## 1. Dolt backend modes — embedded vs server

`bd` has exactly one canonical datastore: **Dolt**. It runs in one of three *modes*, resolved by `internal/doltserver/servermode.go:ResolveServerMode(beadsDir)` (the single source of truth):

| Mode (`ServerMode` enum) | When chosen | Who owns the server |
|---|---|---|
| `ServerModeEmbedded` | `metadata.json` `dolt_mode == "embedded"` | No server — in-process cgo engine |
| `ServerModeOwned` | default (no explicit port, not shared) | `bd` auto-starts/kills a per-project `dolt sql-server` |
| `ServerModeExternal` | `BEADS_DOLT_SERVER_MODE=1`, OR shared-server enabled, OR `metadata.json` has explicit `dolt_server_port` | systemd/Docker/orchestrator/Hosted Dolt — `bd` never starts or kills it |

Decision order (`ResolveServerMode`, lines 60-96): `BEADS_DOLT_SERVER_MODE=1` → shared-server (`IsSharedServerMode()`) → `dolt_mode=embedded` → explicit `dolt_server_port` → default `Owned`. **Runtime env vars (1,2) deliberately override persisted `metadata.json`** so a stale `dolt_mode=embedded` can't shadow active shared-server intent (GH#2949).

### Embedded mode (default for solo users)

- In-process Dolt engine, **no server process, no port, no PID file**. Data at `.beads/embeddeddolt/`. Single-writer. (`docs/DOLT.md:43-51`.)
- Opened by `beads_cgo.go:OpenBestAvailable` → `embeddeddolt.Open(ctx, beadsDir, database, "main")` when `cfg.IsDoltServerMode()` is false.
- Status reported by `cmd/bd/dolt.go:showEmbeddedDoltStatus` — prints `Dolt engine: embedded (in-process, no server)` and `data_dir: <beadsDir>/embeddeddolt`. The JSON shape uses `server_running:false` (NOT `running`) so clients don't misread it as "Dolt unavailable" (`dolt.go:694-704`).
- **Important on-disk fact:** embedded data lives at `.beads/embeddeddolt/`, while *server-mode* data lives at `.beads/dolt/`. These are different directories; `doltserver.go:ResolveDoltDir` defaults to `.beads/dolt`, but embedded status reads `.beads/embeddeddolt`. The auto-import path (`main.go:1049-1058`) exists to migrate pre-0.56 `dolt/` → `1.0+ embeddeddolt/`.

### cgo vs nocgo build variants

Two files implement the same `OpenBestAvailable` behind build tags:

- `beads_cgo.go` (`//go:build cgo`): supports **both** embedded (`embeddeddolt.Open`) and server (`dolt.NewFromConfig`) modes.
- `beads_nocgo.go` (`//go:build !cgo`): server mode only — embedded path returns the literal error `"embedded Dolt requires CGO; use server mode (bd init --server)"` (`beads_nocgo.go:27`).

So a non-cgo build of `bd` **cannot** open an embedded `.beads/embeddeddolt/` database; it must be pointed at a `dolt sql-server`.

### Server mode on-disk layout & state files

State files live in the *server directory*. In per-project (`Owned`) mode that is `.beads/`; in shared mode it is `~/.beads/shared-server/` (`doltserver.go:resolveServerDir`, lines 240-253). The canonical names (`doltserver.go:313-317`):

| File | Const / func | Purpose |
|---|---|---|
| `dolt-server.pid` | `PIDFileName`, `pidPath()` | PID of the managed `dolt sql-server` |
| `dolt-server.port` | `PortFileName`, `portPath()` | **actual** listening port (written by `Start()`) — primary persistent port source |
| `dolt-server.lock` | `lockPath()` | flock for serializing concurrent `Start()` |
| `dolt-server.log` | `logPath()` | server stdout/stderr (`--loglevel=warning`, see below) |
| `.bd-dolt-ok` | `bdDoltMarker` (`doltserver.go:1275`) | compatibility marker inside the `.dolt/` data dir — its **absence** flags a pre-0.56 embedded-era database |

The dolt data dir itself is resolved by `ResolveDoltDir` (lines 262-295): `BEADS_DOLT_DATA_DIR` env (abs or relative-to-beadsDir) > `metadata.json` `dolt_data_dir` > default `.beads/dolt/`. In shared mode it is `~/.beads/shared-server/dolt/` (`SharedDoltDir`).

### Auto-detect / auto-start lifecycle

`EnsureRunning` / `EnsureRunningDetailed` (`doltserver.go:598-654`) is the auto-start entry point:

1. `IsRunning(serverDir)` reads `dolt-server.pid`, verifies the process is alive AND is actually a dolt process (PID-reuse guard), then reads `dolt-server.port`. If the server is up but the port is unknowable, it **stops the orphan** so the next `Start()` writes a fresh port file (`IsRunning`, lines 561-580).
2. If mode is `External` → **refuse to start**, error directs to `bd dolt start` / `bd dolt status` (lines 627-635).
3. If `IsAutoStartDisabled()` (defense-in-depth) → refuse (lines 640-647).
4. Otherwise `Start(serverDir)`.

`Start()` (`doltserver.go:707-938`) is the heavy path:

- Acquires `dolt-server.lock` exclusively (non-blocking first; if held, blocks and re-checks `IsRunning` — double-checked locking, lines 712-745).
- **`KillStaleServers` runs *inside* the lock** to prevent the race where one process kills a server another is mid-start (PID not yet written) — this race caused journal corruption (GH#2430, lines 747-754).
- `exec.LookPath("dolt")`; `ensureDoltIdentity()` (seeds `dolt config --global user.{name,email}` from git config, lines 1239-1269).
- `ensureDoltInit(doltDir)` → `dolt init` if `.dolt/` missing, then seeds `.bd-dolt-ok` (lines 1308-1334).
- Launches `dolt sql-server` detached (`procAttrDetached()`), `cmd.Dir = doltDir`, `--loglevel=warning`.

### Port auto-detection

Default is **OS-assigned ephemeral ports**, NOT a hash-derived scheme (the old hash scheme caused birthday-problem collisions — GH#2098, GH#2372; see file header lines 5-13). `DefaultConfig` (lines 459-524) port priority:

1. `BEADS_DOLT_SERVER_PORT` env.
2. `dolt-server.port` file (gitignored, local — elevated to top to stop git-tracked ports leaking across projects, GH#2372).
3. `config.yaml` `dolt.port`.
4. `metadata.json` `dolt_server_port` (**deprecated** — emits a warning; git-tracked → cross-project data leakage, lines 501-514).
5. Else `0` → `Start()` calls `allocateEphemeralPort()` (`net.Listen(":0")`) with up to `maxEphemeralPortAttempts = 10` retries for the TOCTOU bind race (lines 834-877). Shared mode defaults to `DefaultSharedServerPort = 3308` (avoids orchestrator's 3307).

Explicit ports go through `reclaimPort` (lines 360-393): if the port is busy and the holder is a dolt process *in our data dir*, **adopt** it (return its PID); otherwise error. Hard ceiling: `maxDoltServers() = 3` concurrent servers.

### Circuit breaker

`internal/storage/dolt/circuit.go` — a **file-backed, cross-process** breaker keyed per `host:port:database` (per-database granularity so one bad worktree doesn't trip all of them, GH#3140). State file: `/tmp/beads-dolt-circuit-<host>-<port>.json` (`docs/TROUBLESHOOTING.md:549`).

- `circuitFailureThreshold = 5` consecutive connection failures within `circuitFailureWindow = 60s` → **open**.
- Open rejects all calls with `ErrCircuitOpen` = `"dolt circuit breaker is open: server appears down, failing fast (cooldown 5s)"` (`circuit.go:71`).
- `circuitCooldown = 5s` before a half-open probe; `circuitStaleTTL = 5m` auto-resets a stale open file (prevents a reboot-old breaker poisoning fresh inits).
- Enforced in `store.go:withRetry` (lines 427-457): checked before each op; records connection failures, resets on success. **Port 0 gets no breaker** (`maybeNewCircuitBreaker`, line 73) — sharing breaker state on the unresolved port would poison every fresh init on the machine.
- Manual reset: delete the `/tmp/beads-dolt-circuit-*.json` file (`docs/TROUBLESHOOTING.md:556`).

---

## 2. The rapid-write race (failure mode 6) — at the source level

### The historical mechanism

The race was **inside the SQL transaction pattern**, not the JSONL layer. The old write path was:

```
BEGIN → INSERT → CALL DOLT_COMMIT → tx.Commit()   (redundant explicit Commit)
```

`DOLT_COMMIT` already implicitly ends the SQL transaction, so the trailing `tx.Commit()` "adds raciness" (verbatim from Dolt's Tim Sehn). Under concurrent/rapid sequential writes against a `dolt sql-server`, this raced and could hang the server or drop writes. **The reproducer encodes exactly this:** `scripts/repro-dolt-hang/main.go:360-405` (`doOperation`) runs both patterns:

- `"old"`: `BEGIN → INSERT → DOLT_COMMIT → tx.Commit()` — explicit commit "adds raciness" (comment lines 393-396).
- `"new"`: `BEGIN → INSERT → DOLT_COMMIT` (no `tx.Commit()`) — "Tim's blessed pattern" (file header lines 6-8).

A watchdog goroutine pings the server every 2s; any unresponsive event → `*** SERVER HANG DETECTED ***` exit 1 (`main.go:140-149`).

### What bd 1.0.4 actually does (the race IS mitigated)

The production write path in 1.0.4 uses the **"new" pattern with a single pinned connection** — `internal/storage/dolt/transaction.go:runDoltTransaction` (lines 60-139):

- Pins **one** `conn` for the entire op (SQL tx + config protection + DOLT_COMMIT on the same Dolt session — mixing pool connections makes DOLT_COMMIT see stale working sets, GH#2455, lines 61-65).
- `regularTx.Commit()` then `versioncontrolops.StageAndCommit(...)` — which is just `CALL DOLT_ADD(?)` per dirty table + a single `CALL DOLT_COMMIT('-m', ?, '--author', ?)` (`versioncontrolops/commit.go:41-58`). **No redundant `tx.Commit()` after DOLT_COMMIT.**
- Wrapped in `store.go:withRetry` (lines 427-457) with exponential backoff on retryable/serialization errors (`withRetryTx`, lines 614-626: `InitialInterval=25ms`, `MaxElapsedTime` 5s embedded / 15s server). Serialization conflicts from concurrent writers are retried rather than dropped.
- `"nothing to commit"` is treated as benign (`isDoltNothingToCommit` → `issueops.IsNothingToCommitError`).

**Conclusion (contradicts the legacy belief):** the *transaction-level* hang/drop race (the original "mode 6") is fixed in 1.0.4 — the redundant-commit pattern is gone, writes are single-connection-pinned, and serialization errors retry. The CLAUDE.md "bd ≤1.0.4 silently drops state changes on tight sequential writes" framing conflates two different things and is **stale for the SQL-transaction race**. What remains is the **JSONL-representation lag** (§3), which is a *throttle*, not a dropped DB write — a point operators have since corrected in practice (the issue was reclassified as "mischaracterized — actual cause is the throttle interval").

### Why `bd export` between writes "fixes" it — and what it actually fixes

`bd export` does **not** repair any DB-level loss (there is none in 1.0.4). It force-flushes the **JSONL** representation. The DB is always authoritative and consistent after each `RunInTransaction`; only `.beads/issues.jsonl` can lag (§3). So the safe-write pattern's `bd export` between ops is a *JSONL-freshness* guarantee, not a *data-integrity* one.

### Authoritative safe-write pattern (1.0.4)

```bash
# DB writes are atomic + retried; you do NOT need export-between-writes for DB integrity.
# You DO need it only if you require .beads/issues.jsonl to be byte-fresh after each op
# (e.g. gitignored .beads with all work inside one throttle window — see §3).

# Preferred: batch the writes so bd commits them together (fewer DOLT_COMMITs, no per-op churn):
bd close id1 id2 id3 -r "..."          # one invocation, one transaction boundary

# If you must loop AND need fresh JSONL each step:
for b in id1 id2 id3; do
  bd close "$b" -r "..."
  bd export -o .beads/issues.jsonl >/dev/null 2>&1   # force JSONL flush (bypasses throttle)
done

# Belt-and-suspenders flush at session close:
bd export 2>/dev/null > /tmp/bd-snap.jsonl && cp -f /tmp/bd-snap.jsonl .beads/issues.jsonl
```

The cleaner structural fix is `export.interval=1s` in the workspace `.beads/config.yaml` (§3), which makes the loop's explicit `bd export` unnecessary.

---

## 3. The JSONL throttle / auto-export model — `export_auto.go`

**JSONL is no longer the source of truth in 1.0.4** — Dolt is. `.beads/issues.jsonl` is an *optional export* for viewers (`bv`), interchange, and migration (`CHANGELOG.md` Unreleased "Upgrade Notes"; `README.md:170`).

### Auto-export is OPT-IN in 1.0.4

`maybeAutoExport` (`export_auto.go:37-165`) returns early unless `config.GetBool("export.auto")` is true (line 49). Per `CHANGELOG.md [1.0.4]`, "Auto-export is now opt-in by default" (GH#4062) — fresh repos leave JSONL refresh + git-add disabled unless explicitly enabled:

```bash
bd config set export.auto true
bd config set export.git-add true
```

### The throttle window — confirmed 60s default, configurable

`export_auto.go:78-81`:

```go
interval := config.GetDuration("export.interval")
if interval == 0 {
    interval = 60 * time.Second   // ← the documented default 60s
}
```

The decision flow (lines 84-99):

1. **Change detection first** (cheap): `store.GetCurrentCommit(ctx)`. If the current Dolt commit hash equals `state.LastDoltCommit`, there are *no changes* → skip (no throttle needed). State persists in `.beads/export-state.json` (`exportAutoStateFile`, `exportAutoState` struct lines 24-32).
2. **Then throttle**: `shouldExport(state, interval)` (lines 172-177) returns true only if `state.Timestamp.IsZero()` (first run) or `time.Since(state.Timestamp) >= interval`.

**Therefore the empirically-observed behavior is exactly right:** within the 60s window, a write commits to Dolt (DB always current) but `maybeAutoExport` is throttled, so `.beads/issues.jsonl` does NOT update. **The first op AFTER the window elapses catches the JSONL up** to the latest Dolt commit. DB writes are never lost — only the JSONL representation lags. (Confirmed by the `export.interval=1s` mitigation already in the umbrella `.beads/config.yaml`.)

### When JSONL catches up vs lags

- Catches up: first `bd` write-op after `export.interval` elapses since the last export, *and* the Dolt commit hash has changed.
- Lags: any write within the window (throttled), OR `export.auto=false` (never auto-exports at all — must run `bd export` manually), OR server mode (line 38-41: `maybeAutoExport` skips entirely in `serverMode`), OR running as a git hook (`BD_GIT_HOOK=1`, lines 44-47).

### Gitignored `.beads` interaction

`export.git-add` (line 150): auto-export only `git add`s the JSONL when `export.git-add=true` AND not `no-git-ops` AND `isGitRepo()`. For a **gitignored `.beads/`** (a common umbrella-workspace setup), `gitAddFile` would hit "paths are ignored" — but the whole point is JSONL there is a local viewer artifact, not a tracked file. The export still *writes* the file (atomic temp-then-rename, `exportToFile` lines 344-447); it just isn't staged. So on a gitignored path the only failure surface is the throttle lag, not a git error (the prior "auto-flush drops on gitignored path" framing was wrong).

### Safety guards (1.0.4 additions)

- **Shrink guard** (`guardAutoExportOverwrite`, lines 450-526): refuses to overwrite a JSONL that contains records *outside auto-export scope* (memories, infra/template/ephemeral beads, unknown types) — prevents a viewer refresh silently replacing a richer file (GH#4069).
- **Empty-overwrite guard** (`shouldSkipEmptyAutoExport`, lines 179-194): refuses to overwrite a non-empty JSONL when the DB would export 0 issues.
- **Missing-IDs guard** (`missingJSONLIssueIDsInStore`, lines 204-229): refuses if the JSONL has issue IDs absent from the Dolt store (directs to `bd init --from-jsonl`).
- Memories are **excluded** from auto-export (private agent context must not reach git history, GH#3650, line 121). Ephemeral wisps excluded (GH#3649, `buildAutoExportFilter` lines 333-337).

The PersistentPostRun fan-out order (`main.go:1106-1167`): **auto-commit → tip-metadata commit → auto-backup → auto-export → auto-push**, then `store.Close()`.

---

## 4. `--dolt-auto-commit off|on|batch` — `dolt_autocommit.go` + `_config.go`

The flag `--dolt-auto-commit` (persistent, `main.go:514`) or config key `dolt.auto-commit` or env `BD_DOLT_AUTO_COMMIT`. Three modes (`dolt_autocommit_config.go:10-14`):

| Mode | Behavior (`maybeAutoCommitStore`, `dolt_autocommit.go:46-76`) |
|---|---|
| `off` | No per-command Dolt commit. Changes stay in the working set until an explicit `bd dolt commit` / `bd dolt push` / SIGTERM flush. |
| `on` | After each successful write command, `PersistentPostRun` calls `st.Commit(ctx, msg)` with an auto-generated message `"bd: <cmd> (auto-commit) by <actor> [ids]"` (`formatDoltAutoCommitMessage`, lines 82-113). |
| `batch` | Per-command commits **deferred**. Changes accumulate in the working set across many `bd` commands; committed together at `bd dolt commit` (`dolt.go:365-400`). SIGTERM/SIGHUP flush pending batch commits (flag help, `main.go:514`). |

### Mode-dependent default

`main.go:1010-1022` — when the user sets no value:

- **Server mode → `off`.** The server handles commits via its own transaction lifecycle; firing `DOLT_COMMIT` after every write under concurrent load causes `'database is read only'` errors (comment lines 1011-1013).
- **Embedded mode → `on`.** Each command writes to the working set and needs a Dolt commit in PersistentPostRun to persist to history (lines 1014-1015).

If still empty at use-time, `getDoltAutoCommitMode` falls back to `off` (the safe default, `_config.go:21`). Invalid values error: `invalid --dolt-auto-commit=%q (valid: off, on, batch)`.

### Performance / safety tradeoff

- `on`: every write is a Dolt commit → most history granularity, most commits (storage + GC pressure → `bd compact`/`bd flatten` eventually). Safe: nothing lingers uncommitted.
- `batch`: far fewer commits (good for high-throughput agents) → less GC churn, cleaner history. Risk: uncommitted working-set changes persist until the explicit commit; a hard crash before `bd dolt commit` leaves them only in the working set (still in Dolt, recoverable, but not in history).
- `off`: bd never commits — appropriate when the server/orchestrator owns the commit lifecycle.

`transact()` (`dolt_autocommit.go:17-23`) wraps `RunInTransaction` and sets `commandDidExplicitDoltCommit = true` so PersistentPostRun's `maybeAutoCommit` doesn't double-commit.

---

## 5. Remotes & DoltHub — `dolt.go` + `dolt_autopush.go`

### `bd dolt remote add/list/remove`

`bd dolt remote add <name> <url>` (`dolt.go:941-1043`) writes the remote on **two surfaces**:

1. **SQL server** via `st.AddRemote(ctx, name, url)` (the `dolt_remotes` table).
2. **CLI filesystem** via `doltutil.AddCLIRemote(dbPath, name, url)` (`.dolt/config` — what raw `dolt push` reads). Skipped in embedded mode (SQL and CLI share the directory there).

It prompts on overwrite (`confirmOverwrite`, auto-yes when non-TTY), and **if `name == "origin"`, persists the URL to `config.yaml` as `sync.remote`** so fresh clones can bootstrap (the Dolt DB is gitignored and won't survive `git clone`, lines 1017-1028). `bd dolt remote list` reconciles both surfaces and flags `[SQL only]`/`[CLI only]`/`[CONFLICT]` discrepancies (lines 1099-1147), pointing at `bd doctor --fix`.

### Supported remote URL schemes (`printNoRemoteGuidance`, `dolt.go:173-176`; `FEDERATION-SETUP.md:64-73`)

| Scheme | Example | Protocol |
|---|---|---|
| GitHub (git) | `git+ssh://git@github.com/org/repo.git` | git remote-as-dolt-remote |
| **DoltHub** | `https://doltremoteapi.dolthub.com/<org>/<repo>` | DoltHub remote API, **HTTPS port 443** |
| DoltHub (federation shorthand) | `dolthub://org/repo` | same, via `bd federation` |
| Azure | `az://account.blob.core.windows.net/container/path` | Azure Blob |
| GCS / S3 | `gs://bucket/path`, `s3://bucket/path` | cloud object store |

### DoltHub remote protocol & creds

DoltHub speaks the Dolt remote API at `https://doltremoteapi.dolthub.com/<org>/<repo>` over HTTPS/443. Auth is via **`dolt creds`** (`dolt creds new` + `dolt creds use`, an Ed25519 keypair tied to your DoltHub account) — *not* username/password. For **Hosted Dolt** (a different product) bd uses `DOLT_REMOTE_USER` / `DOLT_REMOTE_PASSWORD` (`credentials.go:436-513`). The credential-scheme routing table (`credentials.go:692-693`) maps `dolthub://` and `https://` to the `DOLT_REMOTE_*` family.

**What makes data appear in a DoltHub account:** the data is associated with whatever DoltHub org/repo the URL names *and* the `dolt creds` identity authorized to push there. You must own (or have write on) `<org>/<repo>` on dolthub.com, and `dolt creds use <pubkey>` must reference a keypair you've added to that DoltHub account. **No push to a DoltHub URL ever lands in a DoltHub account you don't hold creds for** — it 403s.

### What `bd dolt push origin main` does under the hood

`doltPushCmd` (`dolt.go:242-312`) → `st.Push(ctx)` (or `st.PushRemote` for `--remote`). The store-layer router `pushToRemote` (`store.go:2032-2100`) chooses CLI vs SQL by protocol:

- **Git-protocol remotes** (`git+ssh://`, `git://`, SSH) → `doltCLIPush` shells out to real `dolt push` (CALL DOLT_PUSH times out through the SQL connection for git transfers; also passes `GIT_CONFIG_PARAMETERS='core.hooksPath=/dev/null'` to suppress the user's pre-push hook, GH#3724).
- **Credential / cloud-auth / local-remote cases** → CLI subprocess so creds/env reach the dolt process via `cmd.Env`.
- **DoltHub / S3 / GCS / file (non-git, no special creds)** → in-SQL `CALL DOLT_PUSH(?, ?)` (or `CALL DOLT_PUSH('--user', ?, ?, ?)` for Hosted Dolt with `remoteUser`), with a long timeout, no surrounding SQL tx (`execWithLongTimeoutNoTx`, lines 2074-2099).

So `bd dolt push origin main` ≈ `dolt push origin main` but: (a) it auto-adopts `git origin` as a Dolt remote if none configured (`adoptGitOriginRemoteForPush`, lines 179-215); (b) it runs `prePushFSCK` to catch dangling-chunk corruption before pushing; (c) it routes via SQL or CLI per the matrix above; (d) it gives structured diverged-history recovery guidance (`printDivergedHistoryGuidance`, lines 219-240) on "no common ancestor" errors. Raw `dolt push` does none of (a)–(d).

### Auto-push — `dolt_autopush.go` (OPT-IN, single-writer only)

`maybeAutoPush` (lines 105-200) runs in PersistentPostRun **only if `config.GetBool("dolt.auto-push")` is true** (`isDoltAutoPushEnabled`, lines 83-85). It is *not* auto-enabled by an `origin` remote anymore — git+ssh remotes have no chunk-level upload atomicity, so concurrent dolt pushes race on the remote manifest and can leave dangling references (comment lines 77-82). Debounced via `.beads/push-state.json` (file-based to avoid multi-machine merge conflicts, GH#2466): interval `dolt.auto-push-interval` (default 5m), bounded by `dolt.auto-push-timeout` (default 30s, GH#3370). On failure it records the attempt timestamp but NOT a new `LastCommit`, so change-detection re-fires when the remote recovers (lines 179-191).

---

## 6. Backup — `backup_dolt.go` + `backup.go` + `backup_auto.go`

`bd backup` wraps **Dolt's native backup** (`CALL DOLT_BACKUP(...)`, `versioncontrolops/backup.go:12-43`) — full commit history, faster than JSONL for large DBs (`backup_dolt.go:18-24`).

### Commands & targets

- `bd backup init <path>` (alias `add`) — `bs.BackupAdd(name, url)` → `CALL DOLT_BACKUP('add', name, url)`. Saves config to `.beads/dolt-backup.json` (`backup_dolt.go:28-103`).
- `bd backup sync` — first `store.Commit(ctx, "bd: pre-backup commit")`, then `bs.BackupSync(name)` → `CALL DOLT_BACKUP('sync', name)`. Pushes the **entire database state (all branches, full history)**, atomic — failure preserves the prior backup (`backup_dolt.go:105-162`). Records `.beads/dolt-backup-state.json`.
- `bd backup restore` — `CALL DOLT_BACKUP('restore', [--force], url, db)` (`versioncontrolops/backup.go:39-43`).
- `bd backup remove` — `CALL DOLT_BACKUP('rm', name)`.

### Target schemes (`resolveDoltBackupURL`, `backup_dolt.go:167-188`)

`file://<abs>` (local dir / external drive / NAS / Dropbox — bare paths get resolved to absolute + `file://` prefixed), `https://` / `http://` (DoltHub passthrough), `aws://`, `gs://`. The default backup name is `"default"` (`defaultDoltBackupName`).

### `bd backup sync` vs `bd dolt push`

Both use Dolt's distributed machinery, but: **`bd backup sync` → `CALL DOLT_BACKUP('sync')`** (a Dolt *backup* remote — mirrors *all* branches + working set + full history as a restorable backup). **`bd dolt push` → `CALL DOLT_PUSH`** (a Dolt *push* remote — pushes the current branch's commits for sync/sharing). A backup is a complete restorable snapshot; a push is a branch-level replication. (There is **no custom `.darc` archive format** — backups are native Dolt backups; the only on-disk artifacts are `dolt-backup.json` config + `dolt-backup-state.json` state. The "`.db`" strings in `errors.go` are the legacy SQLite filename, unrelated.)

### Why the user's `file://` → GitHub setup is invisible on DoltHub

The umbrella backs up to a `file://` directory which is then committed/pushed to a **GitHub** repo. That is a **Dolt-native backup on a filesystem path** — a directory of Dolt chunk files. Pushing that *directory* to GitHub stores opaque Dolt internal files as git blobs; **it never touches `doltremoteapi.dolthub.com`**. DoltHub only shows repos that were pushed *to a DoltHub remote URL* with valid `dolt creds` (§5). A `file://` backup, even mirrored to GitHub, has no DoltHub remote, no DoltHub creds, no DoltHub org/repo — so nothing appears in any DoltHub account. To appear on DoltHub you must `bd backup add https://doltremoteapi.dolthub.com/<you>/<repo>` (or `bd dolt remote add origin <that-url>`) and push with creds.

`backup_auto.go` provides the throttled auto-backup that fires before auto-export in PersistentPostRun (`maybeAutoBackup`, `main.go:1151`).

---

## 7. Federation — `federation.go` + `FEDERATION-SETUP.md`

Federation = **peer-to-peer sync between independent Dolt-backed beads workspaces**, each keeping its own DB and sharing via Dolt remotes (no central server). **cgo-only** — `federation.go` is `//go:build cgo` (line 1); `federation_nocgo.go` is the stub.

### Topology & commands

Each workspace is autonomous; `add-peer` registers a Dolt remote (≈ `git remote add`); push/pull syncs commits; conflicts resolve by strategy (`FEDERATION-SETUP.md:109-126`). Commands (`federation.go`):

- `bd federation add-peer <name> <url> [--user --password --sovereignty T1..T4]` — with creds → `AddFederationPeer` (encrypted local storage); without → plain `AddRemote`. Reserved names: `origin`, `main`, `master`, `HEAD`.
- `bd federation sync [--peer] [--strategy ours|theirs]` — fetch + merge + push per peer; `origin` is skipped (treated as the backup remote, not a peer, lines 162-167).
- `bd federation status [--peer]` — ahead/behind, reachability (tests via `Fetch`), conflicts.
- `bd federation list-peers` / `remove-peer`.

Peer endpoint schemes (`FEDERATION-SETUP.md:64-73`): `dolthub://org/repo`, `gs://`, `s3://`, `file://`, `https://`, `ssh://`, `git@host:path`. Data sovereignty tiers T1 (no restriction) → T4 (anonymous).

### Shared server / `beads_global` / `bd dolt --global`

This is the **server-consolidation** mechanism (distinct from federation — it's one server, many databases on one machine, not peer-to-peer).

- **Enable shared mode**: `bd init --shared-server` (`init.go:1573`), or `BEADS_DOLT_SHARED_SERVER=1`, or `dolt.shared-server: true` in `config.yaml` (`doltserver.go:IsSharedServerMode`, lines 111-116). All projects on the machine then share **one** `dolt sql-server` at `~/.beads/shared-server/` on the fixed port **3308** (`DefaultSharedServerPort`), each project using its own database (already unique via prefix-based naming).
- **The global database**: `GlobalDatabaseName = "beads_global"`, prefix `global`, sentinel project ID `00000000-0000-0000-0000-000000000000` (`doltserver.go:91-101`). Created idempotently by `EnsureGlobalDatabase` → `CREATE DATABASE IF NOT EXISTS beads_global` (lines 947-980).
- **`bd --global`**: the persistent flag `--global` (`main.go:513`) switches the active DB to `beads_global`. It **requires shared-server mode** — `main.go:988-992` errors `"--global requires shared-server mode (set BEADS_DOLT_SHARED_SERVER=1 or dolt.shared-server: true in config.yaml)"` otherwise. With `--global`, identity validation + sync-branch are skipped (the sentinel project ID won't match any per-project `metadata.json`, `main.go:1056-1066`).
- Home-level `~/.beads` (prefix `OPS`) is a *separate per-workspace* DB, NOT the same thing as `beads_global` — `beads_global` is the project-agnostic shared DB that only exists under shared-server mode.

### Migration path: per-workspace → `--global` / shared-server

Existing per-workspace data is *not* auto-merged into `beads_global` — shared-server just changes *where the server lives and which DB a command targets*. The clean path:

1. Stop the sprawl of per-project servers (`bd dolt killall` per repo, or kill them; §9).
2. Enable shared mode globally: `bd config set dolt.shared-server true` (or export `BEADS_DOLT_SHARED_SERVER=1`). Now every `bd` invocation routes to the single `~/.beads/shared-server/` server on 3308.
3. Each existing project keeps its **own database** on that shared server (databases are prefix-named and unique), so per-project data is preserved — you don't lose anything by consolidating the *server*. The first `bd` command in shared mode that needs the server auto-starts the single shared instance; `EnsureGlobalDatabase` creates `beads_global` on demand if you use `--global`.
4. To *move* a specific project's data onto the shared server's storage when the data dir differs, use the Dolt-native backup round-trip (`bd backup init <path>` + `bd backup sync` in the source, `bd backup restore --force <path>` in the shared-DB target) — `docs/DOLT.md:87-127`. JSONL export is **not** a substitute (no branches/history).
5. `beads_global` itself is opt-in: only data you create *under* `bd --global ...` lives there. To migrate selected per-project issues into the global DB, export from the project and `bd --global import` them.

---

## 8. History management — `compact_dolt.go`, `flatten.go`, `gc.go`

| Command | Source | Semantics | When |
|---|---|---|---|
| `bd compact [--days N] [--dry-run] [--force]` | `compact_dolt.go` | Squash Dolt commits **older than N days (default 30)** into one base commit; cherry-pick recent commits on top; then `DoltGC`. Preserves recent change-tracking. | Routine history trim. `--dry-run` previews the commit breakdown; needs `--force` to proceed. |
| `bd flatten [--dry-run] [--force]` | `flatten.go` | **Nuclear**: squash **ALL** history into a single commit (Tim Sehn recipe — new branch, soft-reset to initial, single snapshot commit, swap main, GC). **Irreversible — all history lost.** | `.beads/dolt` very large; don't need time-travel; want minimal storage. |
| `bd gc [--older-than N] [--skip-decay] [--skip-dolt] [--dry-run] [--force]` | `gc.go` | **Full lifecycle GC, three phases**: (1) DECAY — delete closed issues older than N days (default 90); (2) COMPACT — `bd compact`; (3) GC — Dolt garbage collection to reclaim disk. | Standalone DBs accumulating closed issues + commit bloat. Each phase individually skippable. |

Note distinctions: `bd compact` (Dolt-commit squash) ≠ `bd admin compact` (semantic *issue* compaction — summarizing closed issues, `compact_dolt.go:27`) ≠ `bd wisp gc` (ephemeral-wisp cleanup). `compact_dolt.go` uses `storage.Compactor` + `storage.GarbageCollector` (DoltGC after compact, lines 166-180).

---

## 9. Server lifecycle / cleanup — killing the sprawl

The user's box has **~17 `dolt sql-server` processes** (verified at scan: 17), one per workspace on a random ephemeral port — the per-project (`Owned`) default. Cleanup surface:

- **`bd dolt status`** (`dolt.go:474-531`) — embedded → in-process notice; bd-managed local → PID/port/data/log from the PID file; externally-managed (remote host OR local with `dolt.auto-start: false`) → SQL-probes the endpoint and reports `running (external)` (the 1.0.4 fix, be-0eyj — JSON now emits `{"running":true,"mode":"external"}` instead of the old misleading `running:false`).
- **`bd dolt killall`** (`dolt.go:714-749`) — kills **orphan** dolt servers using *this repo's* data dir that aren't the canonical PID. `killStaleServersForDir` (`doltserver.go:1140-1193`) **never** kills externally-managed servers (auto-start disabled or `ServerModeExternal`) or *other repos'* servers (preserves servers whose CWD ≠ our data dir). Under an orchestrator, the canonical server is at `$GT_ROOT/.beads/`.
- **`bd dolt clean-databases [--dry-run]`** (`dolt.go:762-879`) — drops **stale test/agent databases** off the shared server (prefixes `testdb_`, `doctest_`, `doctortest_`, `beads_pt`, `beads_vr`, `beads_t` — `staleDatabasePrefixes`, line 760). Has a circuit-breaker drop loop (batches of 5, pause 2s, back off 10s after 3 consecutive timeouts, abort after 10 consecutive failures, 30s per-drop timeout). Does **not** touch real project DBs.
- **`bd dolt stop [--force]`** / **`bd dolt start`** — per-project (or shared) server lifecycle.

### How `--global` / shared-server kills the sprawl

The 15-17-server sprawl is *because each workspace runs its own `Owned` per-project server*. Flipping the machine to **shared-server mode** (`dolt.shared-server: true` / `BEADS_DOLT_SHARED_SERVER=1`) collapses all of them to **a single** `dolt sql-server` at `~/.beads/shared-server/` on port **3308** — every project becomes a *database* on that one server instead of a separate process (`doltserver.go:108-116`, 461-465). Procedure: enable shared mode, then `bd dolt killall` in each repo (or kill the per-project servers); the next `bd` command auto-starts the single shared instance. This is the consolidation the plugin's `.mcp.json` wants — one local server it can front with dolt-mcp.

---

## 10. `dolthub/dolt-mcp` — the official Dolt MCP server

Source: [dolthub/dolt-mcp](https://github.com/dolthub/dolt-mcp) · [Announcing Dolt MCP](https://www.dolthub.com/blog/2025-08-14-announcing-dolt-mcp/) · [Announcing Dolt SQL Server MCP](https://www.dolthub.com/blog/2025-09-09-announcing-dolt-sql-server-mcp/) · Docker `dolthub/dolt-mcp:latest`.

The official MCP server that fronts a running `dolt sql-server` over the **MySQL wire protocol** and exposes Dolt's version-control surface as MCP tools — letting an agent inspect, query, branch, and commit, isolating its work to branches.

### Tool surface (40+ tools, exact names)

- **Database**: `list_databases`, `create_database`, `drop_database`, `select_version`
- **Table**: `show_tables`, `show_create_table`, `describe_table`, `create_table`, `alter_table`, `drop_table`
- **Data**: `query` (SELECT), `exec` (DML/DDL)
- **Branch**: `list_dolt_branches`, `select_active_branch`, `create_dolt_branch`, `create_dolt_branch_from_head`, `delete_dolt_branch`, `move_dolt_branch`
- **Version control**: `list_dolt_commits`, `create_dolt_commit`, `stage_table_for_dolt_commit`, `stage_all_tables_for_dolt_commit`, `unstage_table`, `unstage_all_tables`
- **Diff/status**: `list_dolt_diff_changes_in_working_set`, `list_dolt_diff_changes_by_table_name`, `list_dolt_diff_changes_in_date_range`, `get_dolt_merge_status`
- **Merge/reset**: `merge_dolt_branch`, `merge_dolt_branch_no_fast_forward`, `dolt_reset_soft`, `dolt_reset_hard`
- **Remote**: `list_dolt_remotes`, `add_dolt_remote`, `remove_dolt_remote`, `clone_database`, `dolt_fetch_branch`, `dolt_fetch_all_branches`, `dolt_push_branch`, `dolt_pull_branch`

### Transports

- **stdio (default)** — `MCP_MODE=stdio`, binary flag `--stdio`. Ideal for Claude Desktop / Claude Code `.mcp.json`.
- **HTTP** — `MCP_MODE=http`, flag `--http`, `MCP_PORT` (default **8080**), Docker `--mcp-port`.

### Connection config / env (connects to a `dolt sql-server` via MySQL protocol)

Env vars (or equivalent `--host/--user/--password/--port/--database` flags):

| Env | Required | Default |
|---|---|---|
| `DOLT_HOST` | yes | — |
| `DOLT_USER` | yes | — |
| `DOLT_PASSWORD` | no | (empty) |
| `DOLT_PORT` | no | 3306 (Dolt) / 5432 (DoltgreSQL) |
| `DOLT_DATABASE` | no | — |
| `MCP_DIALECT` | no | `dolt` (or `doltgres`); flags `--dolt` / `--doltgres` |

Binary: `dolt-mcp-server`. Example stdio: `./dolt-mcp-server --stdio --dolt --host 0.0.0.0 --port 3306 --user root --database mydb`. Docker: `docker run -e MCP_MODE=stdio -e DOLT_HOST=host -e DOLT_USER=root dolthub/dolt-mcp:latest`.

### In-server MCP (newer alternative)

From **Dolt v1.58.7+**, `dolt sql-server` can start an **embedded MCP HTTP server** alongside it on a separate port, default **7007**. Enable via CLI `--mcp-port=<port> --mcp-user=<user> [--mcp-password] [--mcp-database]`, or YAML:

```yaml
mcp_server:
  port: 7007
  user: mcp_user
  password: mcp_pass
  database: ""
```

⚠️ **Version gate for this box:** the installed `dolt` is **1.83.1** — newer than the 1.58.7 floor, so the in-server MCP *is* available here. But the standalone `dolt-mcp-server` binary/Docker image is the portable choice for an `.mcp.json` because it doesn't depend on how bd launched the server (bd starts `dolt sql-server` with `--loglevel=warning` and no `--mcp-port`, so to use the in-server MCP you'd have to manage the server yourself, i.e. `dolt.auto-start: false` / external mode).

### Plugin wiring note

For the `.mcp.json`, point dolt-mcp at the **shared local server** (host `127.0.0.1`, port `3308` if shared-server mode is enabled — §9; or the per-project `dolt-server.port` value otherwise), `DOLT_USER=root`, `DOLT_DATABASE=<project-db or beads_global>`. Because beads opens its own MySQL connections per `bd` invocation and dolt-mcp holds its own, both can share the one `dolt sql-server` concurrently — that is exactly what shared-server mode is for.

---

## De-risking notes for live ops

**(a) Exact DoltHub remote-add + push.**
```bash
# one-time: create a DoltHub credential keypair tied to your account, then authorize it
dolt creds new          # prints a public key
dolt creds use <pubkey> # (add the pubkey to your DoltHub account settings first)

# register the remote on both surfaces (SQL + CLI) and persist sync.remote:
bd dolt remote add origin https://doltremoteapi.dolthub.com/<your-org>/<repo>
bd dolt push origin main     # routes via CALL DOLT_PUSH(?, ?) for the dolthub HTTPS remote
# (bd auto-runs prePushFSCK and gives diverged-history guidance on "no common ancestor")
```

**(b) Does the DoltHub repo need to pre-exist? YES.** `dolt push` to a DoltHub URL **does not auto-create** the repo — it fails with permission-denied/403 if `<org>/<repo>` doesn't already exist on dolthub.com under an account your `dolt creds` can write. (Confirmed: DoltHub docs + the gastown auto-create feature request [steveyegge/gastown#1415] exists precisely because raw push won't create the repo — beads/gastown has to special-case it via `POST /api/v1alpha1/database`.) **Create the repo in the DoltHub UI (or via that API) first**, then push. This is the opposite of `gh repo create`-on-push behavior — do not assume push auto-provisions.

**(c) Exact `--global` / shared-server consolidation (no data stranding).**
```bash
# 1. Enable shared-server mode machine-wide (persists in ~/.config/bd/config.yaml or per-repo .beads/config.yaml):
bd config set dolt.shared-server true        # or: export BEADS_DOLT_SHARED_SERVER=1

# 2. Tear down the per-project server sprawl (run in each repo, or just kill them):
#    killall is repo-scoped + refuses to touch external/other-repo servers, so it's safe:
bd dolt killall                              # per repo; preserves other repos' + external servers

# 3. First bd command in shared mode auto-starts the SINGLE server at ~/.beads/shared-server/ on :3308.
#    Each existing project keeps its OWN database on that server (prefix-named, unique) — no data lost,
#    because shared-server changes the server location, not the per-project databases.
bd ready                                     # triggers shared-server autostart; verify:
bd dolt status                               # should show Mode: shared server, port 3308

# 4. To use the project-agnostic global DB:
bd --global ready                            # creates/uses beads_global (sentinel project id)

# 5. If a project's data dir must physically move onto shared storage, use the Dolt-native round-trip
#    (NOT jsonl export — that loses branches/history):
#    in source repo:   bd backup init /tmp/proj-bak && bd backup sync
#    in shared target: bd backup restore --force /tmp/proj-bak
```
Data-stranding guard: per-project databases are preserved across the server consolidation; only `beads_global` is a *new* empty DB you opt into. Nothing is auto-merged, so nothing is auto-lost.

**(d) Does upgrading `dolt` 1.83.1 → 2.1.8 trigger a repo-format migration that bd 1.0.4 can't open?**
The dolt MAJOR bump (1.x → 2.x) can change the on-disk storage format. Dolt's policy is forward-compatible-read within a format era, but a 2.x that writes a new `__DOLT__` storage format may produce databases a 1.x-linked reader can't open. **bd 1.0.4 in embedded mode links the Dolt library at *its* version (cgo)** — it does NOT shell to your CLI `dolt` for embedded reads. So:
- **Embedded mode (`.beads/embeddeddolt/`)**: upgrading the *CLI* `dolt` does NOT change what bd opens — bd uses its bundled embedded engine. The risk is only if you *manually* run `dolt 2.1.8` against `.beads/dolt/` and it rewrites the format in place; then bd 1.0.4's bundled (older) engine could fail to read it.
- **Server mode**: bd connects over the MySQL protocol to whatever `dolt sql-server` you point it at. If that server is `dolt 2.1.8` and has migrated the repo format, the wire protocol still works (it's MySQL), but `bd dolt push`/CLI subprocess paths that shell to *your* `dolt` binary inherit that binary's version.
- **Safe upgrade procedure**: before upgrading the CLI dolt, run `bd backup sync` (or `bd dolt push`) so you have a restorable snapshot; upgrade dolt; verify with `bd list` + `bd dolt status`; if embedded reads break, the bundled-engine mismatch is the cause — pin the CLI dolt to a version compatible with bd 1.0.4's embedded engine, or move to server mode against a single managed `dolt sql-server` whose version you control. **Do NOT let `dolt 2.x` rewrite `.beads/dolt/` in place until you've confirmed bd 1.0.4 can still open it.** (And never delete/modify anything inside `.dolt/` — `main.go:1026-1029` warns this causes unrecoverable corruption.)
