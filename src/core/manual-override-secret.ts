import { lstatSync, readFileSync } from 'node:fs'

export interface ManualOverrideSecretOptions {
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the HMAC key without placing a production secret in argv, source,
 * fixtures, or a launchd plist.
 *
 * Production reads only from a non-symlink regular file whose group/other
 * permission bits are zero. The inline environment variable remains available
 * solely for isolated tests so legacy test callers do not need a real secret.
 */
export function resolveManualOverrideSecret(
  envOrOptions: NodeJS.ProcessEnv | ManualOverrideSecretOptions = process.env,
): string | null {
  const env = isOptions(envOrOptions)
    ? envOrOptions.env ?? process.env
    : envOrOptions
  const filePath = env.ALICE_MANUAL_OVERRIDE_SECRET_FILE?.trim()
  if (filePath) {
    return readProtectedSecretFile(filePath)
  }

  if (isTestEnvironment(env)) {
    return normalizeSecret(env.ALICE_MANUAL_OVERRIDE_SECRET)
  }
  return null
}

function readProtectedSecretFile(filePath: string): string | null {
  try {
    const metadata = lstatSync(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null
    if ((metadata.mode & 0o077) !== 0) return null
    return normalizeSecret(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function normalizeSecret(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return Buffer.byteLength(normalized, 'utf-8') >= 32 ? normalized : null
}

function isTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || env.VITEST === 'true'
}

function isOptions(
  value: NodeJS.ProcessEnv | ManualOverrideSecretOptions,
): value is ManualOverrideSecretOptions {
  return Object.prototype.hasOwnProperty.call(value, 'env')
}
