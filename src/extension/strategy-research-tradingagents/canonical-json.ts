import { createHash } from "node:crypto";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function normalizeCanonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeCanonicalJsonValue(item));
  }

  if (typeof value === "object") {
    const normalized: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        continue;
      }
      normalized[key] = normalizeCanonicalJsonValue(entry);
    }
    return normalized;
  }

  throw new TypeError(
    `Unsupported canonical JSON value: ${typeof value}`,
  );
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJsonValue(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
