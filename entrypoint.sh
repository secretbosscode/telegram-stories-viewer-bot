#!/bin/sh
# This script is executed when the Docker container starts.

# Exit immediately if a command exits with a non-zero status.
set -e

# =========================================================================
# DYNAMIC USER MAPPING
# =========================================================================
PUID=${PUID:-568}
PGID=${PGID:-568}

echo "Starting with UID: $PUID, GID: $PGID"

# Change IDs only if running as root and required tools exist
if [ "$(id -u)" = "0" ]; then
  command -v groupmod >/dev/null 2>&1 && groupmod -o -g "$PGID" appgroup || true
  command -v usermod >/dev/null 2>&1 && usermod -o -u "$PUID" appuser || true
fi
# =========================================================================
# PERMISSIONS
# =========================================================================
if [ "$(id -u)" = "0" ]; then
  chown -R appuser:appgroup /data
fi
# =========================================================================
# EXECUTE MAIN COMMAND
# =========================================================================
# `exec gosu appuser "$@"` switches from the root user to 'appuser'
# and then executes the command provided in the Dockerfile's CMD.
if [ "$(id -u)" = "0" ]; then
  echo "Dropping root privileges and starting application..."
  exec gosu appuser "$@"
else
  exec "$@"
fi
