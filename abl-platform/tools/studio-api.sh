#!/usr/bin/env bash
# DEPRECATED: Use scripts/platform-auth.sh studio instead
# This file is a redirect for backward compatibility.
echo "DEPRECATED: Use 'scripts/platform-auth.sh studio $*' instead" >&2
exec "$(dirname "$0")/../scripts/platform-auth.sh" studio "$@"
