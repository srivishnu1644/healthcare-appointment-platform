import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { wasProvided } from "./config/env.js";
import logger from "./utils/logger.js";
import { notFound, errorHandler } from "./middlewares/errorHandler.js";
import { AppError } from "./utils/responses.js";
import { healthCheck } from "./config/database.js";

import authRoutes from "./routes/authRoutes.js";
import doctorRoutes from "./routes/doctorRoutes.js";
import appointmentRoutes from "./routes/appointmentRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";

const app = express();
const log = logger.tag("http");

const IS_PROD = process.env.NODE_ENV === "production";

/* ------------------------------------------------------------------ *
 *  CORS — explicit allow-list, never a wildcard                      *
 * ------------------------------------------------------------------ */

/**
 * Build the allowed-origin list from CORS_ORIGIN.
 *
 * The previous configuration was `origin: CORS_ORIGIN?.split(",") || true`,
 * so an unset variable silently degraded to reflecting ANY origin while
 * `credentials` stayed on. Now the list is always explicit, wildcards are
 * rejected, and a production deployment without CORS_ORIGIN fails at boot.
 *
 * @returns {string[]}
 */
const resolveAllowedOrigins = () => {
  const raw = process.env.CORS_ORIGIN || "";

  // env.js already aborts a production boot when CORS_ORIGIN is missing or
  // contains a wildcard; these checks are a second guard in case the import
  // order ever changes.
  if (IS_PROD && !wasProvided("CORS_ORIGIN")) {
    console.error("[cors] FATAL: CORS_ORIGIN is required in production.");
    process.exit(1);
  }

  const list = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (list.includes("*")) {
    console.error("[cors] FATAL: CORS_ORIGIN must not contain '*'.");
    process.exit(1);
  }

  return list.length ? list : ["http://localhost:5173"];
};

const ALLOWED_ORIGINS = resolveAllowedOrigins();

/* ------------------------------------------------------------------ *
 *  Security headers                                                  *
 *                                                                     *
 *  Registered BEFORE cors on purpose: when cors rejects an origin it   *
 *  short-circuits to the error handler, so headers set afterwards    *
 *  would be missing from that rejection response.                     *
 * ------------------------------------------------------------------ */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite emits a small inline bootstrap in index.html.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // The stylesheet is compiled by Vite; inline styles are used by the
        // hand-written design system today.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...ALLOWED_ORIGINS],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Helmet adds this by default. Over plain http in local development it
        // makes the browser upgrade every request to https, breaking the dev
        // server, so it is enabled in production only.
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
    // The API serves JSON over HTTPS in production; enable HSTS there only so
    // local http development is not pinned to HTTPS.
    hsts: IS_PROD ? undefined : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: same-origin navigation, curl, or a server-to-server
      // call. Nothing to validate.
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

      log.warn(`blocked cross-origin request from ${origin}`);
      // A typed AppError so the global handler answers 403. Passing a bare
      // Error here produced a 500, which misreports a client configuration
      // problem as a server fault.
      return callback(
        new AppError("Origin not allowed", 403, "CORS_ORIGIN_DENIED"),
      );
    },
    // Auth travels in an Authorization header, never in a cookie, so browser
    // credentials are not required. Leaving this off avoids the
    // `Access-Control-Allow-Origin: *` + credentials footgun.
    credentials: false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

/* ------------------------------------------------------------------ *
 *  Core middleware                                                   *
 * ------------------------------------------------------------------ */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// Lightweight request log via our tagged logger.
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    log.info(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`,
    );
  });
  next();
});

/* ------------------------------------------------------------------ *
 *  Health                                                             *
 * ------------------------------------------------------------------ */

// Row counts describe the dataset and are only useful to an operator, so they
// are reported in development and withheld in production.
/**
 * Liveness + database reachability.
 *
 * Row counts describe the dataset and are only useful to an operator, so
 * they are reported in development and withheld in production.
 */
app.get("/api/health", async (req, res) => {
  const dbCheck = await healthCheck();

  if (!dbCheck.ok) {
    log.error(`health check failed: ${dbCheck.error}`);
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
      data: { status: "unhealthy", database: "unreachable" },
    });
  }

  const base = {
    status: "healthy",
    uptime: Math.round(process.uptime()),
  };

  if (IS_PROD) {
    return res.json({ success: true, message: "OK", data: base });
  }

  const { query } = await import("./config/database.js");
  const counts = {
    doctors: (await query("SELECT count(*)::int AS c FROM doctors")).rows[0].c,
    facilities: (await query("SELECT count(*)::int AS c FROM facilities")).rows[0].c,
    services: (await query("SELECT count(*)::int AS c FROM services")).rows[0].c,
    appointments: (await query("SELECT count(*)::int AS c FROM appointments")).rows[0]
      .c,
  };

  return res.json({
    success: true,
    message: "OK",
    data: { ...base, database: "connected", counts },
  });
});

/* ------------------------------------------------------------------ *
 *  API routes                                                         *
 * ------------------------------------------------------------------ */

app.use("/api/auth", authRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);

/* ------------------------------------------------------------------ *
 *  Static client (production build)                                  *
 * ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback for anything that is not an API route.
  app.get(/^\/(?!api\/).*/, (req, res) =>
    res.sendFile(path.join(clientDist, "index.html")),
  );
}

/* ------------------------------------------------------------------ *
 *  404 + error handling                                              *
 * ------------------------------------------------------------------ */

app.use("/api", notFound);
app.use(errorHandler);

export default app;