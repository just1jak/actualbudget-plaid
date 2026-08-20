#!/bin/sh
set -e
if [ "$1" = "scheduler" ]; then
    echo "Starting actualplaid manager with import scheduler"
    exec node /app/index.js server
else
    exec node /app/index.js "$@"
fi
