#!/usr/bin/env bash
# No-dry-run volume breakout wrapper
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
exec /opt/homebrew/bin/node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs scripts/paper_trade_volume_breakout.ts -- --dryRun false --allowUngatedPaperLane true 2>&1
