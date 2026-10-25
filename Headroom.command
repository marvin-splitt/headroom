#!/bin/zsh
# Double-click to start Headroom. It opens in your browser; close this window to quit.
cd "$(dirname "$0")"
exec node server.js "$@"
