import { defineConfig } from 'tsup'

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
})
