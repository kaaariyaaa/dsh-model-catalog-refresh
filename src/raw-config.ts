/**
 * Safe traversal of the raw profile-layer config held by ConfigEditor.
 *
 * The profile document is user-authored YAML, so a key named `__proto__` or
 * a `!!js` expression node must not become a traversal or write primitive.
 *
 * @module dsh-model-catalog-refresh/raw-config
 */

/** A plain data object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Object keys that would escape a plain data tree through a prototype. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** A YAML `!!js` expression node the loader keeps unevaluated. */
export function isExpressionNode(value: unknown): value is { __jsExpr: string } {
  return isRecord(value) && typeof value.__jsExpr === 'string'
}

/**
 * Read a nested own-property value without traversing prototypes.
 * @param root - raw config value.
 * @param path - path from the root.
 * @returns the value, or undefined when any segment is absent.
 */
export function getAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const key of path) {
    if (UNSAFE_KEYS.has(key) || !isRecord(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

/**
 * Set one nested raw config value, refusing a path whose parents do not exist.
 * Treating a missing parent as creatable would let a model list replace a
 * provider profile wholesale; the target must already be in the writable
 * layer. Keys are checked as own properties so a provider named `__proto__`
 * or `constructor` cannot traverse or mutate a prototype.
 * @param root - detached profile-layer config.
 * @param path - path from the config root.
 * @param value - replacement value.
 * @throws {Error} when a parent is missing, not an object, or a dynamic expression.
 */
export function setAtPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]
    if (key === undefined) break
    if (UNSAFE_KEYS.has(key) || !Object.hasOwn(node, key)) {
      throw new Error(`the provider configuration path "${path.join('.')}" is not writable`)
    }
    const next = node[key]
    if (!isRecord(next) || isExpressionNode(next)) {
      throw new Error(`the provider configuration path "${path.join('.')}" is not a writable object`)
    }
    node = next
  }
  const last = path.at(-1)
  if (last === undefined || UNSAFE_KEYS.has(last)) {
    throw new Error('a provider model path is empty or unsafe')
  }
  if (isExpressionNode(node[last])) {
    throw new Error(`the provider configuration path "${path.join('.')}" is a dynamic expression`)
  }
  // defineProperty avoids the legacy `__proto__` setter even for a key that
  // passed the own-property check.
  Object.defineProperty(node, last, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}
