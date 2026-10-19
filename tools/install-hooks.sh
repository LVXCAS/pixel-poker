#!/usr/bin/env bash
# Installs the pre-commit hook that stamps a build id (tools/stamp.py) into index.html + version.json.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cat > "$ROOT/.git/hooks/pre-commit" <<'HOOK'
#!/usr/bin/env bash
# Stamp a fresh build id whenever game files change, so open tabs reload instead of running stale code.
ROOT="$(git rev-parse --show-toplevel)"
if git diff --cached --name-only | grep -qE '^(js/|css/|index\.html$)'; then
  python3 "$ROOT/tools/stamp.py" || exit 1
  git add "$ROOT/index.html" "$ROOT/version.json"
fi
HOOK
chmod +x "$ROOT/.git/hooks/pre-commit"
echo "pre-commit hook installed"
