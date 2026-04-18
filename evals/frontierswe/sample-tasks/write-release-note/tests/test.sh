#!/usr/bin/env bash
set -euo pipefail
grep -qx 'Release note: FrontierSWE sample eval migrated\.' /app/RELEASE_NOTE.md
