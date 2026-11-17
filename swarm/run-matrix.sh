#!/usr/bin/env bash
# Run the scripted swarm at increasing concurrency through every backend.
# Usage: swarm/run-matrix.sh [agents...]   (default: 8 16 32 48)
set -u
cd "$(dirname "$0")/.."
AGENTS=${*:-8 16 32 48}
THINK=${THINK:-400-1600}
for n in $AGENTS; do
  for mode in graft graft-cli git; do
    echo "== $mode x $n"
    node --experimental-sqlite --no-warnings dist/src/swarm/sim.js --mode "$mode" --agents "$n" --think "$THINK" --label scale --runs swarm/runs \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print({k:d[k] for k in ['wallMs','landP50','landP90','conflicts','retries','vcsMsPerAgent','verified']})" \
      || echo "   run failed"
  done
done
