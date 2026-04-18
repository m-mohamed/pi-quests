#!/usr/bin/env bash
set -euo pipefail
grep -q 'npm install --global pi-quests' /app/README.md
! grep -q 'quest-tool' /app/README.md
