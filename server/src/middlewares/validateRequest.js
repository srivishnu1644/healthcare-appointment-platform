/**
 * Tiny declarative validator, so the project does not pull in Joi/Zod.
 *
 * Rules look like:
 *   { field: { required, type, enum, min, max, maxLength, minLength, pattern, default } }
 *
 * `pattern` is a regular expression SOURCE string, compiled once per rule and
 * tested against the value. It is matched against the COERCED value, so a
 * query-string field is checked as the number or boolean it became.
 *
 * `pattern` did not exist until Phase 13, and its absence was not obvious: a
 * route could declare `pattern: "^\\d{4}-\\d{2}-\\d{2}$"`, the rule would be
 * ignored in silence, and the malformed input would fail later and further away -
 * as a 500 from a SQL cast rather than a 422 at the edge.
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

/**
 * How a type is named in an error message.
 *
 * Only needed where the internal type name is not the word a user wants to read.
 * Interpolating the type name directly gives "must be a valid calendarDate",
 * which describes the implementation rather than the problem.
 */
const TYPE_LABELS = {
  calendarDate: "date",
};

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)),

  // A canonical UUID. Phase 13.
  //
  // Every id column here is a `uuid`, so a malformed id is not "not found" -
  // PostgreSQL raises `invalid input syntax for type uuid` and the caller gets a
  // 500. The shape is deliberately exact: PostgreSQL also accepts braces, a
  // `urn:uuid:` prefix and an unhyphenated run, and those resolve to the same
  // row, so accepting them here would make the API accept ids the rest of the
  // codebase cannot round-trip.
  //
  // This is the ONLY uuid predicate in the project. An earlier draft also
  // exported an `isUuid` from utils/time.js; nothing used it, and two copies of
  // one rule is how they drift apart.
  uuid: (v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(v),
    ),
  // SHAPE only. 2026-02-31 passes here on purpose.
  //
  // Making this type stricter (Phase 13 tried, then reverted it) changes an
  // established API contract: `/doctors/:id/slots` validates its own date in
  // the controller and answers a non-existent day with 400 INVALID_DATE, which
  // is a more useful message than a generic 422. Tightening the shared type
  // silently pre-empted that with 422 VALIDATION_ERROR and broke the slot
  // contract for every caller. Existing clients depend on it, so `date` stays
  // shape-only.
  //
  // Use `calendarDate` when the shared type SHOULD do the calendar check - for a
  // new endpoint whose only defence would otherwise be a `::date` cast deeper
  // down, which turns a typo in a query string into a 500.
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)),

  // A real day, not just the right shape.
  //
  // Round-trips through a UTC date: JavaScript NORMALISES an impossible day
  // rather than rejecting it (2026-02-31 becomes 2026-03-03), so a mismatch on
  // the way back is exactly how "that day does not exist" shows up.
  calendarDate: (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const probe = new Date(Date.UTC(y, mo - 1, d));
    return (
      probe.getUTCFullYear() === y &&
      probe.getUTCMonth() === mo - 1 &&
      probe.getUTCDate() === d
    );
  },
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
  // `async` so nested validation can await the recursive middleware. The
  // recursion itself never rejects - errors are collected and passed to `next` -
  // so this adds no unhandled-rejection surface to the request path.
  async (req, res, next) => {
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
              : `${field} must be a valid ${TYPE_LABELS[rule.type] ?? rule.type}`,
        });
        continue;
      }

      // `pattern`, compiled once per rule rather than once per request, and
        // matched against the COERCED value so a query-string field is checked as
        // the number or boolean it became.
        //
        // This rule did not exist until Phase 13, and its absence was quiet: a
        // route could declare a `pattern`, the rule would be ignored in silence,
        // and malformed input failed later and further away - as a 500 from a SQL
        // cast rather than a 422 at the edge.
        if (rule.pattern !== undefined) {
          let re;
          try {
            re = rule instanceof RegExp ? rule : new RegExp(rule.pattern);
          } catch {
            // A malformed pattern is a developer error, not a caller error, so it
            // is reported rather than crashing the request.
            errors.push({ field, message: `${field} has an invalid pattern rule` });
            continue;
          }
          if (!re.test(String(value))) {
            errors.push({ field, message: `${field} has an invalid format` });
            continue;
          }
        }

        // `enumList`: a comma-separated selection validated PART BY PART.
      //
      // `enum` cannot express "?status=scheduled,confirmed" without rejecting
      // the comma, and dropping the multi-value form would break a contract the
      // admin dashboard already uses. Validating each part keeps both.
      //
      // This is what stops `?status=bogus` answering 200 with an empty list,
      // which is indistinguishable from "you have none".
      if (rule.enumList) {
        const parts = String(value)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const bad = parts.filter((x) => !rule.enumList.includes(x));
        if (!parts.length || bad.length) {
          errors.push({
            field,
            message: bad.length
              ? `${field} contains an unknown value: ${bad.join(", ")}`
              : `${field} must not be empty`,
          });
          continue;
        }
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
        continue;
      }

      // Key-count bound for an object. Phase 13.
      //
      // An object has no `.length`, so the bounds above could not see it: a
      // `profile` body carrying ten thousand keys passed every rule this
      // middleware knows how to express.
      if (rule.type === "object" && rule.maxKeys !== undefined) {
        const keys = Object.keys(value).length;
        if (keys > rule.maxKeys) {
          errors.push({
            field,
            message: `${field} must have at most ${rule.maxKeys} fields`,
          });
          continue;
        }
      }

      // Nested rules.
      //
      // Before Phase 13 a nested rule object was SILENTLY IGNORED. Declaring
      // `profile: { type: "object", dateOfBirth: { type: "date" } }` validated
      // only that `profile` was an object; every rule underneath it did nothing,
      // with no warning - the same failure mode as a missing `pattern` rule, and
      // the reason a route can look protected while checking nothing.
      //
      // So an unknown key inside a rule is now an error rather than dead weight.
      // `type`, `enum`, `min`, `max`, `minLength`, `maxLength`, `pattern`,
      // `required`, `default` and `maxKeys` are rule options; everything else is
      // treated as a nested field rule.
      if (rule.type === "object" && value && typeof value === "object") {
        const RESERVED = new Set([
          "type",
          "enum",
          "min",
          "max",
          "minLength",
          "maxLength",
          "pattern",
          "required",
          "default",
          "maxKeys",
          "enumList",
          "message",
        ]);
        const nested = Object.fromEntries(
          Object.entries(rule).filter(([k]) => !RESERVED.has(k)),
        );
        if (Object.keys(nested).length) {
          // The payload is the object's VALUE, not `{ field: value }`: nested
          // rules name the object's own keys, so wrapping it would make the
          // recursive middleware look for `profile.dateOfBirth` inside
          // `req.body.profile.profile.dateOfBirth` and find nothing - every
          // nested rule would silently pass again.
          //
          // `value` is the live object from the parent body, so any coercion the
          // nested pass performs lands on the real request body rather than a
          // throwaway copy.
          //
          // Reusing this same middleware rather than reimplementing the checks
          // keeps nested and top-level rules from drifting apart.
          await new Promise((resolve) => {
            validate(nested, source)({ [source]: value }, {}, (err) => {
              if (err) {
                for (const detail of err.details ?? []) {
                  errors.push({
                    field: `${field}.${detail.field}`,
                    message: detail.message,
                  });
                }
              }
              resolve();
            });
          });
        }
      }
    }

    if (errors.length) {
      return next(new AppError("Validation failed", 422, "VALIDATION_ERROR", errors));
    }
    return next();
  };

export default validate;