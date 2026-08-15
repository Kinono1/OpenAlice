/**
 * Resolve the manual-override HMAC signing secret from environment variables.
 *
 * `ALICE_MANUAL_OVERRIDE_SECRET` is the canonical name. There is no legacy
 * fallback because this is a new control-plane secret introduced alongside
 * the signed-override schema; without it, `loadManualOverride` will refuse
 * to honor any override file (fail-closed).
 *
 * The secret should be a high-entropy random hex string, e.g. produced with
 * `openssl rand -hex 32`.
 */
export function resolveManualOverrideSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.ALICE_MANUAL_OVERRIDE_SECRET?.trim()
  if (value && value.length > 0) {
    return value
  }
  return undefined
}
