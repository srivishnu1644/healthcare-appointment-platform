/**
 * Phase 2 local PostgreSQL.
 *
 * There is no `postgres` binary and no Docker on this machine, so a real
 * PostgreSQL server (compiled to WASM) is started on a unix socket and
 * exposed over the standard PostgreSQL wire protocol. The `pg` driver
 * therefore connects exactly as it would to a hosted Supabase instance:
 *
 *   psql "postgresql://postgres@localhost:5433/medicare"    <- works
 *   DATABASE_URL=postgresql://postgres@localhost:5433/medicare npm run dev
 *
 * This is a development convenience only. Nothing in src/ knows about it.
 */
import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.LOCAL_PG_PORT) || 5433;
const DATA_DIR = process.env.LOCAL_PG_DATA || path.join(os.tmpdir(), "medicare-pg");
const SOCKET_DIR = path.join(DATA_DIR, "socket");

/** Build the postgres:// URL the app is configured with. */
export const LOCAL_URL = `postgresql://postgres@localhost:${PORT}/postgres`;

const start = async () => {
  fs.mkdirSync(SOCKET_DIR, { recursive: true });

  const db = await PGlite.create({
    dataDir: path.join(DATA_DIR, "data"),
    extensions: { btree_gist, citext },
  });

  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: "127.0.0.1",
    socketDir: SOCKET_DIR,
  });
  await server.start();

  const version = (await db.query("select version()")).rows[0].version;
  log("local PostgreSQL ready");
  log(`  version : ${version.split(" ").slice(0, 2).join(" ")}`);
  log(`  url     : ${LOCAL_URL}`);
  log(`  dataDir : ${DATA_DIR}`);
  log(`  reset   : rm -rf ${DATA_DIR}`);
  return { db, server };
};

const log = (msg) => console.log(`[localdb] ${msg}`);

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(`[localdb] failed: ${err.message}`);
    process.exit(1);
  });
}

export { start, log };