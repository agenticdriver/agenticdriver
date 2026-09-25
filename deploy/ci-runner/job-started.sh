#!/bin/sh
# GitHub runner hooks accept .sh/.js/.ps1 entrypoints, not .py directly.
exec /usr/bin/python3 -I "${0%/*}/job-started.py"
