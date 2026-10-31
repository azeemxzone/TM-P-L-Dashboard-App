/**
 * Recursively removes keys whose value is undefined.
 * Keeps null, 0, false, and empty strings.
 * Handles nested objects and arrays.
 */
export function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripUndefined(item)) as unknown as T;
  }

  // Preserve special non-plain objects (like Date, FieldValue, etc.)
  if (obj.constructor && obj.constructor.name !== 'Object') {
    return obj;
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = stripUndefined(value);
    }
  }

  return result as T;
}
