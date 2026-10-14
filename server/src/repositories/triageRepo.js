/**
 * AI triage audit records.
 *
 * Every triage is persisted so the "recommendation, not diagnosis" framing is
 * auditable, and so provider latency and fallback rate are measurable.
 *
 * Kept in its own module rather than folded into analyticsRepo: these rows are
 * a clinical audit trail, not dashboard aggregates, and they have different
 * retention and access characteristics.
 */
import { rows, one } from "../config/database.js";

const TRIAGE_COLUMNS = `
  t.id, t.user_id, t.description, t.provider, t.urgency,
  t.departments, t.red_flags, t.summary, t.latency_ms, t.created_at
`;

/**
 * Record one triage result.
 *
 * @param {object} input
 * @param {string|null} [input.userId]
 * @param {string} input.description
 * @param {string} input.provider   e.g. "google-gemini:gemini-2.0-flash"
 * @param {string} input.urgency    low | medium | high
 * @param {string[]} input.departments
 * @param {string[]} input.redFlags
 * @param {string} input.summary
 * @param {number} input.latencyMs
 * @returns {Promise<string|null>} the new id, or null if the write failed
 */
export const record = async ({
  userId = null,
  description,
  provider,
  urgency,
  departments = [],
  redFlags = [],
  summary,
  latencyMs,
}) => {
  const r = await one(
    `INSERT INTO triage_sessions
       (user_id, description, provider, urgency, departments, red_flags,
        summary, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      userId,
      String(description).slice(0, 4000),
      provider,
      urgency,
      departments,
      redFlags,
      summary ?? null,
      latencyMs,
    ],
  );
  return r?.id ?? null;
};

/** A user's own triage history. Scoped by the caller, not by role. */
export const listForUser = async (userId, limit = 25) =>
  (
    await rows(
      `SELECT ${TRIAGE_COLUMNS}
         FROM triage_sessions t
        WHERE t.user_id = $1
        ORDER BY t.created_at DESC
        LIMIT $2`,
      [userId, Math.min(Number(limit) || 25, 100)],
    )
  ).map((r) => ({
    id: r.id,
    description: r.description,
    provider: r.provider,
    urgency: r.urgency,
    departments: r.departments,
    redFlags: r.red_flags,
    summary: r.summary,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  }));

export default { record, listForUser };