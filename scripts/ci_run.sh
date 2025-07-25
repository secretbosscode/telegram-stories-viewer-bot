#!/usr/bin/env bash
set -euo pipefail

# Install Node dependencies without peer dep checks
npm ci --legacy-peer-deps

# Run tests
npm test
