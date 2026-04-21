#!/usr/bin/env bash
set -euo pipefail
test -x /app/scripts/healthcheck.sh
diff -u <(printf '#!/usr/bin/env sh\nset -eu\necho healthy\n') /app/scripts/healthcheck.sh
