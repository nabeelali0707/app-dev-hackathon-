#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
node --test tests/unit.test.js
node tests/smoke.js
