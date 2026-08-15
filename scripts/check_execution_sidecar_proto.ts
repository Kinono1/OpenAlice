#!/usr/bin/env tsx

import { pathToFileURL } from 'node:url'
import { verifyExecutionSidecarProtoFreshness } from './manage_local_release.js'

export async function main(): Promise<void> {
  await verifyExecutionSidecarProtoFreshness(process.cwd())
  console.log('execution sidecar protobuf bindings are up to date')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
