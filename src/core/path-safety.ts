export interface SafePathComponentOptions {
  kind?: string
  maxLength?: number
  allowCaret?: boolean
}

const DEFAULT_MAX_LENGTH = 128
const BASE_COMPONENT_RE = /^[A-Za-z0-9._-]+$/
const CARET_COMPONENT_RE = /^[A-Za-z0-9._^-]+$/
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function safePathComponent(
  value: string,
  opts?: SafePathComponentOptions,
): string {
  const kind = opts?.kind ? `${opts.kind} path component` : 'path component'
  const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH

  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error(`${kind} maxLength must be a positive integer`)
  }
  if (typeof value !== 'string') {
    throw new Error(`${kind} must be a string`)
  }
  if (value.length === 0) {
    throw new Error(`${kind} must not be empty`)
  }
  if (value.length > maxLength) {
    throw new Error(`${kind} exceeds maximum length ${maxLength}`)
  }
  if (value !== value.trim()) {
    throw new Error(`${kind} must not contain leading or trailing whitespace`)
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`${kind} must not contain control characters`)
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`${kind} must not contain path separators`)
  }
  if (isAllDots(value)) {
    throw new Error(`${kind} must not be "." or consist only of dots`)
  }
  if (WINDOWS_RESERVED_DEVICE_RE.test(value)) {
    throw new Error(`${kind} must not use a Windows reserved device name`)
  }

  const allowedPattern = opts?.allowCaret ? CARET_COMPONENT_RE : BASE_COMPONENT_RE
  if (!allowedPattern.test(value)) {
    const allowed = opts?.allowCaret
      ? 'ASCII letters, digits, ".", "_", "-", and "^"'
      : 'ASCII letters, digits, ".", "_", and "-"'
    throw new Error(`${kind} may only contain ${allowed}`)
  }

  return value
}

function isAllDots(value: string): boolean {
  for (const char of value) {
    if (char !== '.') {
      return false
    }
  }
  return true
}
