/**
 * What the assistant knows, and how it decides what to say.
 *
 * WHY A KNOWLEDGE BASE AND NOT JUST A MODEL
 * -----------------------------------------
 * Four of the five things the assistant is asked for - how to book, how to
 * reschedule, how to cancel, how to check in, what the queue words mean, and
 * where things are in MediCare - have exactly right answers, and they are
 * answers THIS application is responsible for being right about. A model
 * improvising "you can cancel up to two hours before" would be inventing a
 * policy. So those answers are written out here, in this file, where they can
 * be reviewed, and they are returned verbatim.
 *
 * The model is consulted for exactly one class of question: general healthcare
 * information, where there is no single correct answer this codebase owns.
 *
 * This is also the main safety property. The assistant cannot be talked into
 * changing a booking, because it has no ability to: the model returns text and
 * nothing else, and there is no code path from its output to a database write.
 */

/** Every answer the application owns. Keyed by intent, matched in order. */
export const KNOWLEDGE = [
  {
    intent: "book",
    patterns: [
      /\b(book|schedule|make)\b.*\b(appointment|visit|slot|consultation)\b/i,
      /\bhow (do|can) i (book|schedule|make)\b/i,
      /\bhow does?\b.*\bbooking\b/i,
      /\bget an appointment\b/i,
    ],
    answer:
      "Booking an appointment in MediCare takes four steps:\n\n" +
      "1. Open Doctors and choose a provider - you can filter by specialty, " +
      "city, fee or video/in-person.\n" +
      "2. Open the provider's profile and pick an available date and time.\n" +
      "3. Review the summary - the provider, the time and the fee - and confirm.\n" +
      "4. The appointment appears under My Appointments straight away.\n\n" +
      "You can book for yourself only. Each appointment is tied to your own " +
      "account, and one person cannot hold two overlapping appointments.",
    followUps: [
      "You can change the time with Reschedule on My Appointments.",
      "Appointments can be booked for video or in person.",
    ],
  },
  {
    intent: "reschedule",
    patterns: [
      /\b(reschedule|re-?schedule|move|change)\b.*\b(appointment|visit|slot|time|date)\b/i,
      /\bhow (do|can) i (reschedule|change|move)\b/i,
      /\bchange the (time|date) of\b/i,
      /\bbook a different (time|slot)\b/i,
    ],
    answer:
      "To move an appointment:\n\n" +
      "1. Go to My Appointments.\n" +
      "2. Open the appointment and choose Reschedule.\n" +
      "3. Pick a new available time and confirm.\n\n" +
      "The old time is released as soon as you confirm the new one. You can " +
      "only reschedule an appointment that has not started yet, and you " +
      "cannot move an appointment into a slot that overlaps another one you " +
      "already hold.",
    followUps: [
      "A rescheduled appointment becomes eligible for a new reminder.",
      "Rescheduling more than once is fine, as long as each new time is free.",
    ],
  },
  {
    intent: "cancel",
    patterns: [
      /\bcancel\b/i,
      /\b(delete|remove|drop)\b.*\bappointment\b/i,
      /\bcan'?t make it\b/i,
      /\bnot going\b/i,
    ],
    answer:
      "To cancel an appointment:\n\n" +
      "1. Go to My Appointments.\n" +
      "2. Open the appointment and choose Cancel.\n" +
      "3. Optionally give a reason, then confirm.\n\n" +
      "The time is released immediately and becomes bookable by other " +
      "patients. Cancelling cannot be undone - you would need to book a new " +
      "appointment. You can cancel an appointment that has not yet started.",
    followUps: [
      "A cancelled appointment stays in your history.",
      "You will get a notification confirming the cancellation.",
    ],
  },
  {
    intent: "checkin",
    patterns: [
      /\bcheck[\s-]?in\b/i,
      /\barriv(e|al|ed)\b/i,
      /\bwait(ing)?\b.*\b(turn|room|queue)\b/i,
      /\bin the (waiting )?room\b/i,
      /\bon time\b/i,
    ],
    answer:
      "Checking in tells the provider you have arrived:\n\n" +
      "1. Open the appointment under My Appointments.\n" +
      "2. Choose Check in.\n\n" +
      "You can only check in once your slot has actually started - not before, " +
      "not after it has been cancelled or completed. After you check in you " +
      "join the provider's waiting room and your place in the line is shown on " +
      "the appointment.",
    followUps: [
      "Arriving about ten minutes early is usual.",
      "If you cannot arrive, cancelling frees the time for someone else.",
    ],
  },
  {
    intent: "queue-terms",
    patterns: [
      /\bwhat (does|do)\b.*\b(queue|position|waiting room|called)\b/i,
      /\b(what|meaning)\b.*\b(checked in|in consultation|in progress|in progress)\b/i,
      /\bwhy\b.*\b(position|number|rank)\b/i,
      /\bhow (is|are) (the )?(people|patients) (ordered|queued)\b/i,
      /\bwhat (does|is)\b.*\bposition \d\b/i,
      /\bqueue (number|meaning|position)\b/i,
    ],
    answer:
      "The waiting room is one provider, for one day. Several patients can be " +
      "waiting for the same provider at the same time, so the room is not a " +
      "single appointment slot.\n\n" +
      "• Your position is your place in the LINE, counted from 1 in order of " +
      "arrival. It is recalculated as people come and go, so if the patient " +
      "ahead of you is called, your number goes down by one.\n" +
      "• Position 1 means you are next to be seen.\n" +
      "• While a patient is with the provider, that person is shown as in " +
      "consultation and is not given a place in the line.\n" +
      "• Checking in joins the queue. It does not guarantee being seen " +
      "immediately.\n" +
      "• The provider chooses who is called next, and you will get a " +
      "notification when it is your turn.",
    followUps: [
      "Your place in the line is not the same as your appointment time.",
      "Only one patient is in consultation at a time per provider.",
    ],
  },
  {
    intent: "navigate",
    patterns: [
      /\bwhere (do|can|is|are)\b/i,
      /\bnavigate\b/i,
      /\bfind (the|my|a)\b/i,
      /\bhow do i (find|get to|open|navigate)\b/i,
      /\bmenu\b/i,
    ],
    answer:
      "Where things are in MediCare:\n\n" +
      "• Doctors - search and filter providers, then open a profile to book.\n" +
      "• My Appointments - everything you have booked, with check-in, " +
      "reschedule and cancel.\n" +
      "• Notifications - confirmations, reminders, and when it is your turn. " +
      "The bell in the header shows how many you have not read.\n" +
      "• Profile - your details and sign-out.\n" +
      "• Symptom checker - suggests which department to book with.\n" +
      "• Help - this assistant.\n\n" +
      "Providers see the same layout with an extra Provider page for their " +
      "schedule and waiting room.",
    followUps: [
      "Every page is reachable from the header.",
      "This assistant is always in the same place.",
    ],
  },
  {
    intent: "payments",
    patterns: [
      /\b(pay|payment|fee|cost|price|money|refund|insurance)\b/i,
      /\bhow much\b/i,
    ],
    answer:
      "Consultation fees are shown on each provider's profile and again in the " +
      "booking summary before you confirm, so you always see the amount before " +
      "committing. Each slot has its own fee, and a video consultation may be " +
      "priced differently from an in-person one.\n\n" +
      "MediCare does not process payment inside this app and cannot issue " +
      "refunds - please settle with the facility directly.",
    followUps: [],
  },
  {
    intent: "scope",
    patterns: [
      /\b(diagnos\w*|prescrib\w*|medicat\w*|symptom|treatment|dose|dosage)\b/i,
      /\bwhat (is|are) my\b/i,
      /\bmy (results|record|report|history|diagnosis|medication)\b/i,
      /\bshould i take\b/i,
      /\bis it (safe|dangerous)\b/i,
      /\bemergency\b/i,
    ],
    answer:
      "I can help with how MediCare works - booking, rescheduling, cancelling, " +
      "checking in, the waiting room, and general healthcare information.\n\n" +
      "I cannot diagnose you, prescribe or suggest medication and dosage, read " +
      "your medical records, or give you a treatment plan. Nothing I say is a " +
      "substitute for a clinician who can actually examine you.\n\n" +
      "If you have severe pain, difficulty breathing, chest pressure, heavy " +
      "bleeding, or any symptom you are worried about, please seek emergency " +
      "care rather than asking here.",
    followUps: [],
  },
];

/** The permanent frame printed with every answer, whatever produced it. */
export const MEDICAL_DISCLAIMER =
  "MediCare's assistant gives general information only. It cannot diagnose, " +
  "prescribe, or read your medical records, and it is not a substitute for a " +
  "doctor. For anything about your own health, speak to a clinician.";

/**
 * Refusals, for questions that are not in the knowledge base but still must not
 * reach a model. Matching these before anything else means a question that both
 * looks like an injection and asks for a diagnosis is refused either way.
 */
export const REFUSALS = [
  {
    patterns: [
      /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
      /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?|training)/i,
      /forget\s+(everything|all)\s+(you|above|before)/i,
      /new\s+instructions?\s*[:,-]/i,
      /you\s+are\s+now\s+/i,
      /from\s+now\s+on\s+you/i,
      /system\s*prompt/i,
      /\bdeveloper\s+mode\b/i,
      /\bjailbreak\b/i,
      /\bact\s+as\s+(a|an)\s+(unrestricted|unfiltered|evil)/i,
      /reveal\s+(your|the)\s+(instructions?|prompt|system|rules?|api\s*key)/i,
      /(print|show|output|repeat)\s+(your|the)\s+(instructions?|prompt|system)/i,
      /\b(api[_ -]?key|secret|password|token|credential)s?\b.*\b(give|show|print|tell)\b/i,
      /\b(sql|query)\b.*\b(select|insert|update|delete|drop|from\s+\w+\s+where)\b/i,
      // A bare statement, with no "SQL" in front of it, is just as much an
      // attempt as one that names the language.
      /\b(select|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table)\b/i,
      /\b(drop|truncate)\b\s+(table|database)/i,
      /\bdelete\s+all\b/i,
      /\bbook\s+(me|an? appointment)\b.*\bwithout\b/i,
    ],
    reason:
      "That request asks me to change how I behave, reveal internal " +
      "instructions, or reach into the system - so I have not answered it. I " +
      "can only help with how MediCare works and with general healthcare " +
      "information.",
  },
];

/** Topics that go to the model, because this codebase has no right answer. */
export const GENERAL_HEALTH = "general-health";

export const GENERAL_HEALTH_PATTERNS = [
  /\b(what (is|are|does))\b.*\b(symptom|condition|disease|illness)\b/i,
  /\b(why (do|does|are|is))\b/i,
  /\b(what|why) (could|can|might)\s+(cause|be|happen|explain)\b/i,
  /\b(what|why)\b.*\b(cause[sd]?|reason|explains?)\b/i,
  /\b(how (do|does|to) (i )?(prevent|reduce|lower|improve))\b/i,
  /\b(is it (safe|normal|common|ok|okay))\b/i,
  /\b(what (should|can) i (do|eat|take))\b/i,
  /\b(general|general information|explain)\b/i,
  /\b(diet|exercise|sleep|hydration|fitness|nutrition)\b/i,
  /\b(what happens)\b/i,
  /\b(when should i)\b/i,
  /\b(first aid|self-care)\b/i,
  /\b(vaccine|vaccination|immunisation|immunization)\b/i,
  // "I have a headache and my back aches" - a described symptom with no explicit
  // question. This is the common shape, and without it such a message falls
  // through to "I am not sure what you are asking".
  /\b(i (have|'ve got|am getting)|my \w+ (hurts?|aches?|itches?))\b/i,
];

/** Menu entries the UI renders; kept beside the knowledge base so they agree. */
export const SUGGESTED_QUESTIONS = [
  "How do I book an appointment?",
  "How do I check in when I arrive?",
  "What does my queue position mean?",
  "Can I reschedule or cancel?",
  "Where can I find my notifications?",
  "What is a consultation fee?",
  "I have a headache - what could cause it?",
];