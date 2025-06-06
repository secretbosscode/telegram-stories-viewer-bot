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

# Change the group ID of 'appgroup' to match the host's group ID
groupmod -o -g "$PGID" appgroup
# Change the user ID of 'appuser' to match the host's user ID
usermod -o -u "$PUID" appuser

# =========================================================================
# PERMISSIONS
# =========================================================================
chown -R appuser:appgroup /app/data

# =========================================================================
# EXECUTE MAIN COMMAND
# =========================================================================
# `exec gosu appuser "$@"` switches from the root user to 'appuser'
# and then executes the command provided in the Dockerfile's CMD.
echo "Dropping root privileges and starting application..."
exec gosu appuser "$@"
