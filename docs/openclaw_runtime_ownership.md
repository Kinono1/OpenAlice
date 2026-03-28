# OpenClaw Runtime Ownership

This repo contains a legacy standalone Telegram connector at `src/connectors/telegram/*`.

That code is suitable for local OpenAlice development, but it is not guaranteed to match the
multi-account Telegram implementation running in the globally installed `openclaw` package.

Maintenance rule:

- If the production host is running `openclaw` from a global install, production Telegram behavior
  is owned by that installed runtime.
- Changes under `src/connectors/telegram/*` only affect this repo's standalone entrypoints.
- When fixing a live Telegram outage, always confirm which runtime actually started the providers
  before patching code.

The browser/gateway config helpers under `src/openclaw/config/config.ts` are shared infrastructure
used by the repo's browser and gateway surfaces and should remain real, persistent config IO.
