-- ============================================================
--  001_extensions.sql — PostgreSQL extensions
--
--  btree_gist : required so an EXCLUDE constraint can mix a scalar
--               equality (uuid) with a range overlap (tstzrange).
--               This is what makes concurrency-safe booking possible
--               at the database level.
--  citext     : case-insensitive email uniqueness, replacing the
--               case-insensitive comparison previously done in JS.
--  pgcrypto   : NOT required. gen_random_uuid() has been part of
--               PostgreSQL core since v13, and Supabase provisions v15+.
--               Deliberately not installed: some minimal builds do not ship
--               it, and a missing extension would abort the whole migration
--               for no benefit.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;