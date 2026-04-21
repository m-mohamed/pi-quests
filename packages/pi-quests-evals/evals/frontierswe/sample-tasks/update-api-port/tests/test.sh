#!/usr/bin/env bash
set -euo pipefail
grep -qx 'PORT=3100' /app/config/app.env
grep -qx 'HOST=127.0.0.1' /app/config/app.env
