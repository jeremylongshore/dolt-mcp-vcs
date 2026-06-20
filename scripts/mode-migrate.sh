#!/usr/bin/env bash
# mode-migrate.sh — consolidate per-project bd Dolt servers onto ONE shared
# server (`bd dolt --global` / shared-server mode, :3308). No data is merged or
# moved: each project keeps its own database on the single shared server, which
# collapses the per-workspace server sprawl.
#
# DRY-RUN BY DEFAULT. This flips a machine-wide setting and stops running
# servers, so it prints the plan and exits unless you pass --apply.
#
# Usage:  mode-migrate.sh                 # dry run: show the plan
#         mode-migrate.sh --apply         # actually enable shared-server mode
#         mode-migrate.sh --status        # show current mode + server count
#
# Migration path (verified against bd 1.0.4 source; see references/beads-dolt-internals.md §7):
#   1. bd config set dolt.shared-server true     (machine-wide)
#   2. bd dolt killall                            (per repo; refuses external/other-repo servers)
#   3. next bd command auto-starts ONE server at ~/.beads/shared-server/ on :3308
# Back up first: bd export && bd backup sync.
set -uo pipefail
command -v bd >/dev/null 2>&1 || { echo "error: bd not on PATH" >&2; exit 2; }

MODE="dryrun"
case "${1:-}" in
  --apply) MODE="apply" ;;
  --status) MODE="status" ;;
  "") MODE="dryrun" ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

running="$(pgrep -fc 'dolt sql-server' 2>/dev/null || echo 0)"
shared_raw="$(bd config get dolt.shared-server 2>/dev/null | tail -1 || echo '?')"
case "$shared_raw" in
  *true*)  shared="true" ;;
  *false*) shared="false" ;;
  *"not set"*|"") shared="false (default — not set)" ;;
  *) shared="$shared_raw" ;;
esac

if [ "$MODE" = "status" ]; then
  echo "dolt.shared-server = $shared"
  echo "running dolt sql-server processes = $running"
  exit 0
fi

echo "# Current: dolt.shared-server=$shared, $running running server(s)."
echo "# Plan to consolidate onto ONE shared server (:3308), no data moved:"
echo "#   1. bd export && bd backup sync        # safety checkpoint FIRST"
echo "#   2. bd config set dolt.shared-server true"
echo "#   3. (in each active workspace) bd dolt killall"
echo "#   4. next bd command auto-starts the single shared server"

if [ "$MODE" = "dryrun" ]; then
  echo
  echo "# DRY RUN — nothing changed. Re-run with --apply to enable shared-server mode."
  echo "# (Per-workspace 'bd dolt killall' is left to you to run intentionally in each repo.)"
  exit 0
fi

# --apply: only the machine-wide flag is flipped here; killall stays manual per-repo
# so this script never tears down a server out from under an active session.
echo
echo "# --apply: enabling shared-server mode (flag only; run 'bd dolt killall' per repo yourself)."
read -r -p "Proceed? [y/N] " ans
case "$ans" in
  y|Y) bd config set dolt.shared-server true && echo "✓ dolt.shared-server=true. Now run 'bd dolt killall' in each active workspace." ;;
  *) echo "aborted." ; exit 0 ;;
esac
