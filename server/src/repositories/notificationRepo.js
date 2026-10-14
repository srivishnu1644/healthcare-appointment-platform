/**
 * Notifications and their per-channel delivery attempts.
 *
 * Replaces a single JSON row per message that carried `channel: "both"`
 * and a `results[]` blob, and drops the hard 500-row truncation
 * (`db.notifications.length = 500`) that silently deleted the oldest
 * messages.
 */
import { query, rows, one } from "../config/database.js";

const toNotification = (r) =>
  r && {
    id: r.id,
    event: r.event,
    appointmentId: r.appointment_id,
    userId: r.user_id,
    patientId: r.user_id, // the JSON field the client reads
    patientName: r.user_name,
    channel: r.channel ?? "in-app",
    subject: r.title, // `title` in the schema, `subject` on the wire
    body: r.body,
    phone: r.phone,
    email: r.email,
    status: r.status,
    createdAt: r.created_at,
    read: r.read_at !== null,
    readAt: r.read_at,
    results: r.results || [],
  };

/**
 * List a user's notifications, newest first.
 *
 * `patientId` is deliberately absent: Phase 1 restricted this to the
 * caller, and that check belongs in the controller, not here.
 */
export const listForUser = async (userId, limit = 50) => {
  // Clamped on BOTH sides.
  //
  // `Math.min(Number(limit) || 50, 200)` had no lower bound, so `?limit=-1`
  // became `LIMIT -1` and PostgreSQL raised "LIMIT must not be negative" - a 500
  // for a query parameter. `|| 50` only catches 0, NaN and "", never a negative
  // number, because -1 is truthy.
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return (
    await rows(
      `SELECT n.id, n.user_id, n.appointment_id, n.event, n.title, n.body,
              n.read_at, n.created_at,
              u.full_name AS user_name,
              d.channel, d.destination AS email,
              (SELECT jsonb_agg(jsonb_build_object(
                         'channel', d2.channel,
                         'delivered', d2.status = 'sent',
                         'simulated', d2.status = 'simulated',
                         'error', d2.error))
                 FROM notification_deliveries d2
                WHERE d2.notification_id = n.id) AS results
         FROM notifications n
         JOIN users u ON u.id = n.user_id
         LEFT JOIN LATERAL (
              SELECT channel, destination, status, error
                FROM notification_deliveries
               WHERE notification_id = n.id
               ORDER BY channel LIMIT 1
         ) d ON true
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT ${safeLimit}`,
      [userId],
    )
  ).map(toNotification);
};

/** Unread count for the header badge. */
export const unreadCount = async (userId) => {
  const r = await one(
    "SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId],
  );
  return r.c;
};

/**
 * Mark every unread notification for a user as read. Returns the count,
 * which the endpoint now reports (it previously mutated memory without
 * persisting and reported nothing).
 */
export const markAllRead = async (userId) => {
  const r = await one(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return r.count ?? 0;
};

export const markOneRead = async (id, userId) => {
  await query(
    "UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
    [id, userId],
  );
};

/**
 * Mark one notification read, reporting whether this call was the one that did it.
 *
 * `markOneRead` above cannot distinguish "marked" from "already read" or "not
 * yours", so the endpoint has no way to answer honestly. The ownership check is
 * the same WHERE clause either way - this only adds the RETURNING that makes the
 * outcome observable.
 *
 * @returns {Promise<boolean>} false when the id is not the caller's, or was
 *        already read.
 */
export const markOneReadCounted = async (id, userId) => {
  const r = await query(
    `UPDATE notifications SET read_at = now()
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING id`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
};

/**
 * Create a notification and its delivery rows in one call.
 *
 * `withTx` lets the caller enlist this in the booking transaction, so a
 * crash cannot lose or duplicate the message.
 */
export const create = async (
  {
    id,
    userId,
    appointmentId = null,
    event,
    title,
    body,
    templateKey = null,
    dedupeKey = null,
    deliveries = [],
  },
  tx = null,
) => {
  const runner = tx ?? { query };

  // A duplicate is handled by the database refusing the row, NOT by catching an
  // exception. This matters more than it looks: this runs inside the transaction
  // that booked the appointment, and in PostgreSQL a failed statement ABORTS the
  // whole transaction - every later statement then fails with "current transaction
  // is aborted", and the COMMIT rolls back the booking itself.
  //
  // So the retried request that a duplicate index is there to absorb would, on the
  // old code, undo the very booking it was retrying. ON CONFLICT DO NOTHING
  // never raises, so the transaction stays healthy and only the extra message is
  // dropped.
  //
  // The index predicate is restated because it is a PARTIAL unique index;
  // PostgreSQL needs it to infer which index is meant.
  const r = dedupeKey
    ? await runner.query(
        `INSERT INTO notifications
           (id, user_id, appointment_id, event, title, body, template_key, dedupe_key)
         VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [id ?? null, userId, appointmentId, event, title, body, templateKey, dedupeKey],
      )
    : await runner.query(
        `INSERT INTO notifications
           (id, user_id, appointment_id, event, title, body, template_key, dedupe_key)
         VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [id ?? null, userId, appointmentId, event, title, body, templateKey, dedupeKey],
      );

  // No row back means the dedupe index rejected it: this event already has a
  // message. The caller treats that as "nothing to send", NOT as a failure.
  if (!r.rows.length) return null;
  const notificationId = r.rows[0].id;

  for (const d of deliveries) {
    await runner.query(
      `INSERT INTO notification_deliveries (notification_id, channel, destination, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (notification_id, channel) DO NOTHING`,
      [notificationId, d.channel, d.destination ?? null, d.status ?? "queued"],
    );
  }

  return notificationId;
};

/**
 * Record the outcome of one delivery attempt against its channel row.
 *
 * `status` and `channel` are enums while `providerMsgId` is text, so the
 * placeholders are cast explicitly: PostgreSQL cannot deduce that a single
 * parameter is both a text and a delivery_status.
 *
 * @param {string} notificationId
 * @param {{channel: string, status: string, error?: string|null,
 *          providerMsgId?: string|null}} attempt
 */
export const recordDelivery = async (notificationId, attempt) => {
  await query(
    `UPDATE notification_deliveries
        SET status = $2::delivery_status,
            error = $3,
            provider_msg_id = $4,
            attempted_at = now(),
            delivered_at = CASE WHEN $2::delivery_status = 'sent'
                                THEN now() ELSE NULL END
      WHERE notification_id = $1 AND channel = $5::notify_channel`,
    [
      notificationId,
      attempt.status,
      attempt.error ?? null,
      attempt.providerMsgId ?? null,
      attempt.channel,
    ],
  );
};

/** Platform-wide log for the admin notification screen. */
export const listAll = async (limit = 100) => {
  const safeLimit = Math.min(Number(limit) || 100, 500);
  return (
    await rows(
      `SELECT n.id, n.user_id, n.event, n.title, n.body, n.created_at, n.read_at,
              u.full_name AS user_name, u.email, u.phone,
              d.channel, d.status,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'channel', d2.channel,
                           'delivered', d2.status = 'sent',
                           'simulated', d2.status = 'simulated',
                           'error', d2.error))
                  FROM notification_deliveries d2
                 WHERE d2.notification_id = n.id
              ), '[]'::jsonb) AS results
         FROM notifications n
         JOIN users u ON u.id = n.user_id
         LEFT JOIN LATERAL (
              SELECT channel, status FROM notification_deliveries
               WHERE notification_id = n.id ORDER BY channel LIMIT 1
         ) d ON true
        ORDER BY n.created_at DESC
        LIMIT ${safeLimit}`,
    )
  ).map(toNotification);
};

/** Counts for the admin dashboard tiles. */
export const stats = async () =>
  one(`SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM notification_deliveries d
            WHERE d.notification_id = notifications.id AND d.status = 'sent'
         ))::int AS sent,
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM notification_deliveries d
            WHERE d.notification_id = notifications.id AND d.status = 'sent'
         ))::int AS simulated
       FROM notifications`);

/* ------------------------------------------------------------------ *
 *  Outbox (written in the booking transaction, drained in Phase 10)   *
 * ------------------------------------------------------------------ */

export const outbox = {
  enqueue: async ({ event, aggregateId, payload }, tx = null) => {
    const runner = tx ?? { query };
    await runner.query(
      `INSERT INTO notification_outbox (event, aggregate_id, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [event, aggregateId, JSON.stringify(payload ?? {})],
    );
  },

  /**
   * Deliveries still waiting for an attempt, oldest first.
   *
   * Used by the after-commit delivery pass to retry anything an earlier attempt
   * left in `queued`, and by the Phase 10 outbox worker.
   */
  pendingDeliveries: async (limit = 50, tx = null) => {
    const runner = tx ?? { rows };
    return runner.rows(
      `SELECT d.id, d.notification_id, d.channel, d.destination, n.body, n.title
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE d.status = 'queued'
        ORDER BY d.attempted_at NULLS FIRST, d.id
        LIMIT $1`,
      [Math.min(Number(limit) || 50, 200)],
    );
  },

  /**
   * Deliveries the drain should attempt now.
   *
   * Two different populations, deliberately in one query:
   *   * never attempted (`attempted_at IS NULL`) - a message whose process died
   *     between the commit and the send;
   *   * attempted before the backoff window - a channel that was down, or a
   *     transient provider error.
   *
   * A row attempted inside the window is left alone, so a provider that is down
   * for an hour is contacted once per window rather than once per tick.
   */
  drainable: async (limit = 100, backoffMinutes = 5) =>
    rows(
      `SELECT d.id, d.notification_id, d.channel, d.destination, n.body, n.title
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE d.status = 'queued'
          AND (d.attempted_at IS NULL
               OR d.attempted_at < now() - ($1 || ' minutes')::interval)
        ORDER BY d.attempted_at NULLS FIRST, d.id
        LIMIT $2`,
      [String(backoffMinutes), Math.min(Number(limit) || 100, 500)],
    ),

  /** How many channels of this message are still queued. */
  pendingFor: async (notificationId) =>
    one(
      `SELECT count(*)::int AS c FROM notification_deliveries
        WHERE notification_id = $1 AND status = 'queued'`,
      [notificationId],
    ).c,

  /** Mark the outbox markers for a notification done. */
  markDoneFor: async (notificationId) =>
    query(
      `UPDATE notification_outbox
          SET status = 'done', processed_at = now()
        WHERE aggregate_id = $1 AND status <> 'done'`,
      [notificationId],
    ),

  /**
   * Give up on deliveries that have been attempted too many times.
   *
   * Without this, a permanently undeliverable channel is retried on every tick
   * for ever, which is wasted work and a drain that can never report itself
   * clean.
   */
  parkStale: async (maxAttempts = 5, withinHours = 24) => {
    const r = await query(
      `WITH stale AS (
         SELECT d.id
           FROM notification_deliveries d
          WHERE d.status = 'queued'
            AND d.attempted_at IS NOT NULL
            AND d.attempted_at > now() - ($2 || ' hours')::interval
            AND (SELECT count(*) FROM notification_deliveries x
                  WHERE x.notification_id = d.notification_id
                    AND x.attempted_at IS NOT NULL) >= $1
       )
       UPDATE notification_deliveries
          SET status = 'failed',
              error = COALESCE(error, 'abandoned after repeated attempts')
        WHERE id IN (SELECT id FROM stale)
       RETURNING id`,
      [Number(maxAttempts), String(withinHours)],
    );
    return r.rowCount ?? 0;
  },

  /**
   * Mark an outbox row done, so a worker does not re-handle it.
   *
   * `WHERE status <> 'done'` keeps it idempotent if two workers race.
   */
  markDone: async (outboxId, tx = null) => {
    const runner = tx ?? { query };
    await runner.query(
      `UPDATE notification_outbox
          SET status = 'done', processed_at = now()
        WHERE id = $1 AND status <> 'done'`,
      [outboxId],
    );
  },

  /**
   * Record a delivery attempt that failed in a way the caller must not see.
   *
   * Distinct from `recordDelivery`, which reports a channel outcome. This exists
   * so an unexpected error in the delivery pass is persisted rather than
   * swallowed, keeping the audit trail honest without ever propagating into the
   * booking path.
   */
  recordFailure: async (notificationId, error, tx = null) => {
    const runner = tx ?? { query };
    await runner.query(
      `UPDATE notification_deliveries
          SET status = 'failed', error = $2, attempted_at = now()
        WHERE notification_id = $1 AND status = 'queued'`,
      [notificationId, String(error).slice(0, 500)],
    );
  },
};

/**
 * Appointments due for a reminder inside `hours`, used by the sweep.
 */
export const remindersDue = async (hours = 24) =>
  rows(
    `SELECT a.id, a.patient_id, a.slot_id, a.doctor_id, a.facility_id,
            a.starts_at, a.reminder_sent_at
       FROM appointments a
      WHERE a.status IN ('confirmed','scheduled')
        AND a.reminder_sent_at IS NULL
        AND a.starts_at BETWEEN now() AND now() + ($1 || ' hours')::interval
      ORDER BY a.starts_at`,
    [String(hours)],
  );

/** Record one background pass. */
export const createSweep = async ({
  kind,
  startedAt = null,
  processed = 0,
  skipped = 0,
  failed = 0,
  notes = null,
}) => {
  const r = await query(
    `INSERT INTO notification_sweeps
       (kind, started_at, finished_at, processed, skipped, failed, notes)
     VALUES ($1, COALESCE($2, now()), now(), $3, $4, $5, $6)
     RETURNING id`,
    [kind, startedAt, Number(processed), Number(skipped), Number(failed), notes],
  );
  return r.rows[0].id;
};

/** Most recent passes, newest first, for the scheduler status endpoint. */
export const recentSweeps = async (limit = 20) =>
  rows(
    `SELECT id, kind, started_at, finished_at, processed, skipped, failed, notes
       FROM notification_sweeps
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.min(Number(limit) || 20, 100)],
  );

export default {
  listForUser,
  unreadCount,
  markAllRead,
  markOneRead,
  markOneReadCounted,
  create,
  recordDelivery,
  listAll,
  stats,
  outbox,
  remindersDue,
  createSweep,
  recentSweeps,
};