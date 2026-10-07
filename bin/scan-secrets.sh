#!/usr/bin/env bash
set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o "$tmp/gitleaks.tar.gz"
printf '%s  %s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb "$tmp/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
# Only tracked source is exported: ignored build and fixture state is never scanned/uploaded.
mkdir "$tmp/source"
git archive HEAD | tar -x -C "$tmp/source"
"$tmp/gitleaks" dir "$tmp/source" --redact --no-banner
"$tmp/gitleaks" git . --log-opts="--all" --redact --no-banner
