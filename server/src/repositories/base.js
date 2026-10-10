/**
 * Shared repository helpers.
 *
 * Repositories are the only place that writes SQL. They translate between
 * the database's snake_case columns and the camelCase object shapes the
 * existing controllers, services and client already expect, so no
 * business-logic file had to change its response contract.
 *
 * Two conventions apply throughout:
 *   * every value is passed as a $n parameter, never interpolated;
 *   * SELECT lists name their columns explicitly. `SELECT *` is banned
 *     because it is how `doctor.user.password` leaked in Phase 0.
 */
import { rows, one } from "../config/database.js";

/**
 * Business/display timezone.
 *
 * Sourced from utils/time.js so there is exactly one place that knows which zone
 * the clinic operates in, and one place that validates it. Slots are stored as
 * absolute instants; the local date and clock time the API returns are derived
 * with `AT TIME ZONE`, matching how the JavaScript side renders them.
 */
import { TZ as BUSINESS_TZ } from "../utils/time.js";

export const TZ = BUSINESS_TZ;

/** Safe interpolation of the timezone into SQL (config value, not user input). */
export const tzLiteral = `'${BUSINESS_TZ.replace(/'/g, "''")}'`;

/**
 * SQL expressions producing the legacy API date/time fields from a slot.
 * Exported so every repository derives them identically.
 */
export const DATE_EXPR = (alias, col = "starts_at") =>
  `to_char(${alias}.${col} AT TIME ZONE ${tzLiteral}, 'YYYY-MM-DD')`;

export const TIME_EXPR = (alias, col = "starts_at") =>
  `to_char(${alias}.${col} AT TIME ZONE ${tzLiteral}, 'HH24:MI')`;

/**
 * Run a SELECT and return rows.
 * @param {string} text
 * @param {any[]} params
 */
export const find = (text, params = []) => rows(text, params);

/**
 * Run a SELECT and return the first row, or null.
 * @param {string} text
 * @param {any[]} params
 */
export const findOne = (text, params = []) => one(text, params);

/**
 * Build a parameterised `IN (...)` list.
 * @param {any[]} values
 * @param {number} startIndex 1-based index of the first placeholder
 * @returns {{clause: string, params: any[]}} e.g. {clause:'$1,$2', params:[a,b]}
 */
export const inClause = (values, startIndex = 1) => {
  const list = [...values];
  if (!list.length) return { clause: "NULL", params: [] };
  const placeholders = list.map((_, i) => `$${startIndex + i}`);
  return { clause: placeholders.join(","), params: list };
};

/**
 * Wrap a repository call so a missing row becomes a clear domain error
 * instead of an undefined dereference downstream.
 *
 * @param {string} entity   human name, e.g. "Doctor"
 * @param {string} id
 * @param {Function} loader async (id) => row|null
 * @param {string} code    error code, e.g. "DOCTOR_NOT_FOUND"
 */
export const requireFound = async (entity, id, loader, code) => {
  const row = await loader(id);
  if (!row) {
    const { AppError } = await import("../utils/responses.js");
    throw new AppError(`${entity} not found`, 404, code);
  }
  return row;
};

export default { TZ, DATE_EXPR, TIME_EXPR, find, findOne, inClause };