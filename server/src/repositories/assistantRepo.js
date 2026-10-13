/**
 * Audit trail for assistant exchanges.
 *
 * TWO ABSENCES THAT ARE THE POINT
 * -------------------------------
 * There is no `user_id` and no `appointment_id` in this table, and that is a
 * deliberate privacy decision rather than an oversight. The assistant is not
 * allowed to know who is asking about what - it is never sent the caller's
 * identity - so storing one here would be recording data the assistant was never
 * given. A support engineer reading these rows learns what people asked the
 * assistant, never which patient asked it.
 *
 * `role` is recorded because a refusal rate that is wildly different between
 * patients and providers would be worth knowing about. It is the coarse role,
 * never an identifier.
 *
 * Every query is a write or an aggregate. There is no "read this patient's
 * conversation" query, because the data to answer it does not exist.
 */
import { query, rows } from "../config/database.js";

export const recordTurn = async ({
  role = "patient",
  intent = null,
  provider = "medicare-knowledge-base",
  sourcedFrom = "knowledge-base",
  question,
  answer,
  latencyMs = null,
}) => {
  const r = await query(
    `INSERT INTO ai_assistant_turns
       (role, intent, provider, sourced_from, question, answer, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      role,
      intent,
      provider,
      sourcedFrom,
      String(question).slice(0, 4000),
      String(answer).slice(0, 4000),
      latencyMs === null ? null : Number(latencyMs),
    ],
  );
  return r.rows[0].id;
};

/**
 * Aggregates for the admin screen.
 *
 * Counts by intent and source, and the refusal rate. Not the questions
 * themselves: an admin needs to know "people keep asking how to cancel", not to
 * read what each of them typed.
 */
export const stats = async () => {
  const byIntent = await rows(
    `SELECT intent, count(*)::int AS n
       FROM ai_assistant_turns
      GROUP BY intent
      ORDER BY n DESC`,
  );
  const bySource = await rows(
    `SELECT sourced_from AS source, count(*)::int AS n
       FROM ai_assistant_turns
      GROUP BY sourced_from`,
  );
  return {
    total: byIntent.reduce((a, r) => a + r.n, 0),
    byIntent,
    bySource,
    // Refusals are recorded as an intent, so the rate needs no extra column.
    refused: byIntent.find((r) => r.intent === "refused")?.n ?? 0,
  };
};

export default { recordTurn, stats };