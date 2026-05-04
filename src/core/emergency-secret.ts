/**
 * Resolve the emergency-close shared secret from environment variables.
 *
 * `ALICE_EMERGENCY_SECRET` is the preferred name.
 * `EMERGENCY_SECRET` is kept as a backward-compatible fallback.
 */
export function resolveEmergencySecret(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const preferred = env.ALICE_EMERGENCY_SECRET?.trim();
  if (preferred) {
    return preferred;
  }

  const legacy = env.EMERGENCY_SECRET?.trim();
  if (legacy) {
    return legacy;
  }

  return undefined;
}
