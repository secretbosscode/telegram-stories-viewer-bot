#!/bin/sh
# This script is executed when the Docker container starts.

# Exit immediately if a command exits with a non-zero status.
set -e

# =========================================================================
# DYNAMIC USER MAPPING
# -------------------------------------------------------------------------
# This section checks for PUID and PGID environment variables and applies
# them to the 'appuser'. This ensures that the user inside the container
# has the same ID as the user on the host machine, fixing volume
# permission issues. It defaults to 1001 if the variables aren't set.
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
# -------------------------------------------------------------------------
# This ensures that the persistent data directory is owned by our user,
# allowing the bot to write to its database.
# =========================================================================
chown -R appuser:appgroup /app/data


# =========================================================================
# EXECUTE MAIN COMMAND
# -------------------------------------------------------------------------
# `exec gosu appuser "$@"` switches from the root user to 'appuser'
# and then executes the command provided in the Dockerfile's CMD.
# `exec` replaces the shell process, so your Node.js app becomes PID 1.
# =========================================================================
echo "Dropping root privileges and starting application..."
exec gosu appuser "$@"
