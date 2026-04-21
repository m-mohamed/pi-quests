Update the repository in `/app`.

Create `scripts/healthcheck.sh` with exactly this content:

```sh
#!/usr/bin/env sh
set -eu
echo healthy
```

Make the script executable.
