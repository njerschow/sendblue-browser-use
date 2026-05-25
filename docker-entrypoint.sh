#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
chown -R bun:bun "$DATA_DIR"

exec gosu bun "$@"
