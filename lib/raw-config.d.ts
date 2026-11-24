/**
 * Safe traversal of the raw profile-layer config held by ConfigEditor.
 *
 * The profile document is user-authored YAML, so a key named `__proto__` or
 * a `!!js` expression node must not become a traversal or write primitive.
 *
 * @module dsh-model-catalog-refresh/raw-config
 */
/** A plain data object. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** A YAML `!!js` expression node the loader keeps unevaluated. */
export declare function isExpressionNode(value: unknown): value is {
    __jsExpr: string;
};
/**
 * Read a nested own-property value without traversing prototypes.
 * @param root - raw config value.
 * @param path - path from the root.
 * @returns the value, or undefined when any segment is absent.
 */
export declare function getAtPath(root: unknown, path: readonly string[]): unknown;
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
export declare function setAtPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void;
//# sourceMappingURL=raw-config.d.ts.map