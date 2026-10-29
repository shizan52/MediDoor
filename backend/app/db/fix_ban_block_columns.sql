-- ============================================================================
-- MediDoor — production Postgres hotfix for the admin "HTTP 500" problem.
--
-- ROOT CAUSE
--   The SQLAlchemy models (backend/app/models/user.py) declare ban/block
--   columns on customer_profiles + pharmacy_profiles, but the auto-migrator
--   (backend/app/db/migrate.py) ONLY patches SQLite — it returns early for
--   Postgres. So on the live Postgres DB these columns were never created.
--   Every admin list/ban/block query does `SELECT <all mapped columns>` and
--   Postgres raises `column ... does not exist` -> the API returns HTTP 500,
--   which is why admin.py could neither list nor ban/block any user.
--
-- HOW TO APPLY (on the VPS, against the live database)
--   psql "<DATABASE_URL without the +asyncpg driver suffix>" -f fix_ban_block_columns.sql
--   e.g.  psql "postgresql://medidoor:****@localhost:5432/medidoor" -f fix_ban_block_columns.sql
--
-- Safe to run more than once (IF NOT EXISTS guards). No data is modified.
-- ============================================================================

BEGIN;

-- ---- customer ban fields (admin Ban / Unban) ----
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS is_banned  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS ban_notice TEXT;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS banned_at  TIMESTAMPTZ;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS banned_by  VARCHAR(255);
CREATE INDEX IF NOT EXISTS ix_customer_profiles_is_banned ON customer_profiles (is_banned);

-- ---- pharmacy block fields (admin Block / Unblock) ----
ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS is_blocked   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS block_notice TEXT;
ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS blocked_at   TIMESTAMPTZ;
ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS blocked_by   VARCHAR(255);
CREATE INDEX IF NOT EXISTS ix_pharmacy_profiles_is_blocked ON pharmacy_profiles (is_blocked);

COMMIT;

-- After this runs, restart (or it's fine to leave running) the FastAPI backend
-- and the admin tool's user list / ban / block / unban / unblock will work.
