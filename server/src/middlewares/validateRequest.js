/**
 * Tiny declarative validator, so the project does not pull in Joi/Zod.
 *
 * Rules look like:
 *   { field: { required, type, enum, min, max, maxLength, minLength, default } }
 *
 * `min`/`max` are type-aware:
 *   * number -> a numeric bound, inclusive
 *   * string / array -> a length bound
 * `maxLength` always means string length, for readability at the call site.
 *
 * Query-string coercion
 * ---------------------
 * Everything in `req.query` is a string, so `?limit=10` would otherwise fail a
 * `type: "number"` check and every numeric query parameter would be unusable.
 * When the source is `query` (or `params`), a value that is a well-formed numeric
 * string is coerced to a number first.
 *
 * Body values are NOT coerced. A JSON body containing `"duration": "30"` is
 * genuinely the wrong type and should be rejected rather than quietly accepted.
 */
import { AppError } from "../utils/responses.js";

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)),
};

const COERCIBLE_SOURCES = new Set(["query", "params"]);

/**
 * Turn a query-string value into the type the rule expects.
 *
 * Only strings are converted, and only for `query` / `params`:
 *   * `"12"` -> 12 for a numeric rule. Everything in a query string is a
 *     string, so `?limit=10` would otherwise fail a number check.
 *   * `"true"` / `"false"` -> boolean for a boolean rule. The directory UI
 *     sends `?acceptingOnly=true`, so without this every such request 422s.
 *     `"1"` / `"0"` are accepted as well, because `?range=1` is what people
 *     actually type for a flag and rejecting it is a papercut, not a
 *     safeguard. Anything else is left alone, so the type check still rejects
 *     it - in particular `"maybe"` does not become `true`.
 *
 * Anything else is left alone, so the type check still rejects it. Body values
 * are never coerced: a JSON body containing `"duration": "30"` is genuinely
 * the wrong type.
 *
 * @returns the coerced value, or the original when it does not match.
 */
const coerce = (value, source, type) => {
  if (!COERCIBLE_SOURCES.has(source)) return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();

  if (type === "boolean") {
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    return value;
  }

  if (type === "number") {
    // Number("") is 0 and Number(" 12 ") is 12, but an empty string is an
    // absent parameter, not a zero.
    if (trimmed === "") return value;
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return value;
    return Number(trimmed);
  }

  return value;
};

const validate =
  (rules, source = "body") =>
  (req, res, next) => {
    const payload = req[source] || {};
    const errors = [];

    for (const [field, rule] of Object.entries(rules)) {
      let value = payload[field];

      // Coerce before the presence check, so the value is validated and later
      // read in its final form rather than the raw query string.
      if (value !== undefined && rule.type) {
        const coerced = coerce(value, source, rule.type);
        if (coerced !== value) {
          value = coerced;
          req[source][field] = coerced;
        }
      }

      if (value === undefined || value === "" || value === null) {
        if (rule.default !== undefined) {
          req[source][field] = rule.default;
          continue;
        }
        if (rule.required) {
          errors.push({ field, message: `${field} is required` });
        }
        // Nothing to check for this field. `continue`, not `return`: returning
        // here would exit the middleware before next() is ever reached and
        // leave the request hanging.
        continue;
      }

      if (rule.type && !TYPE_CHECKS[rule.type](value)) {
        errors.push({
          field,
          message:
            rule.type === "number"
              ? `${field} must be a number`
              : `${field} must be a valid ${rule.type}`,
        });
        continue;
      }

      if (rule.enum && !rule.enum.includes(value)) {
        errors.push({
          field,
          message: `${field} must be one of: ${rule.enum.join(", ")}`,
        });
        continue;
      }

      // Numeric bounds. Previously `min` was compared against `value.length`,
      // which is undefined for a number, so a numeric `min` was silently
      // ignored - a validation rule that never fires.
      if (rule.type === "number") {
        if (rule.min !== undefined && value < rule.min) {
          errors.push({ field, message: `${field} must be at least ${rule.min}` });
          continue;
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push({ field, message: `${field} must be ${rule.max} or less` });
          continue;
        }
      }

      // Length bounds for strings and arrays.
      const length = typeof value === "string" || Array.isArray(value) ? value.length : undefined;
      const minLength = rule.minLength ?? (rule.type === "string" ? rule.min : undefined);
      if (minLength !== undefined && length !== undefined && length < minLength) {
        errors.push({
          field,
          message: `${field} must be at least ${minLength} characters`,
        });
        continue;
      }
      if (rule.maxLength !== undefined && length !== undefined && length > rule.maxLength) {
        errors.push({
          field,
          message: `${field} must be under ${rule.maxLength} characters`,
        });
      }
    }

    if (errors.length) {
      return next(new AppError("Validation failed", 422, "VALIDATION_ERROR", errors));
    }
    return next();
  };

export default validate;