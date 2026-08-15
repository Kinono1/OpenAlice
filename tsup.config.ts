import { defineConfig } from 'tsup'
import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const EXECUTION_PROTO_SOURCE = resolve('src/sidecar/proto/openalice_execution_v1.proto')
const EXECUTION_PROTO_DESTINATION = resolve('dist/proto/openalice_execution_v1.proto')

/**
 * Keep Node's protocol-qualified built-ins intact in the immutable runtime.
 *
 * tsup defaults to removing the `node:` prefix. That is unsafe for built-ins
 * introduced under a protocol-qualified name, such as `node:sqlite`: the
 * resulting bare `sqlite` import is not a Node built-in and fails from a
 * dependency-isolated release directory.
 */
export default defineConfig({
  removeNodeProtocol: false,
  async onSuccess() {
    // execution-grpc-transport resolves this file relative to the emitted ESM
    // bundle.  Treat it as a required runtime asset, not a source-only file.
    await mkdir(resolve('dist/proto'), { recursive: true })
    await copyFile(EXECUTION_PROTO_SOURCE, EXECUTION_PROTO_DESTINATION)
  },
})
