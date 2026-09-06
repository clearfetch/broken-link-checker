#!/usr/bin/env bash
# Runs the Actor locally against test-inputs/<name>.json with charging simulation.
# Usage: scripts/run-test.sh default | empty | invalid-urls | error-hosts
set -uo pipefail
cd "$(dirname "$0")/.."
NAME="${1:-default}"
IN="test-inputs/$NAME.json"
[ -f "$IN" ] || { echo "no such test input: $IN"; exit 2; }
rm -rf storage/datasets
mkdir -p storage/key_value_stores/default
cp "$IN" storage/key_value_stores/default/INPUT.json
echo "=== $NAME ==="
ACTOR_TEST_PAY_PER_EVENT=true ACTOR_USE_CHARGING_LOG_DATASET=true node src/main.js
CODE=$?
echo "--- exit code: $CODE"
node scripts/summarize.mjs
exit $CODE
