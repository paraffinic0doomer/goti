-- Adds `pots.invite_code` — the mechanism by which anyone actually JOINS a pot.
--
-- WHY THIS IS HAND-WRITTEN
-- Prisma offered to reset the database instead. Adding a REQUIRED UNIQUE column
-- to a populated table cannot be done in one step: existing rows have no value,
-- and NOT NULL + UNIQUE cannot be satisfied retroactively without one.
--
-- So this follows the expand–contract sequence DATABASE.md §7 prescribes:
--   1. add the column NULLABLE
--   2. backfill every existing row
--   3. only then apply NOT NULL and the unique index
--
-- Each step is safe with old code still running, and no data is lost.

-- ---------------------------------------------------------------------------
-- Code generator.
--
-- Alphabet deliberately excludes 0/O/1/I/L: an invite code gets read aloud,
-- screenshotted and retyped, and those four characters are where transcription
-- errors come from. 31^8 ≈ 8.5e11 combinations, so collisions are negligible
-- and the unique index catches the ones that happen anyway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION goti_generate_invite_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  result text := '';
  i int;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN result;
END;
$$;

-- --- 1. EXPAND: nullable, so existing rows remain valid -------------------
ALTER TABLE pots ADD COLUMN invite_code VARCHAR(12);

-- --- 2. BACKFILL: one code per existing pot, retrying on collision --------
DO $$
DECLARE
  pot RECORD;
  candidate text;
BEGIN
  FOR pot IN SELECT id FROM pots WHERE invite_code IS NULL LOOP
    LOOP
      candidate := goti_generate_invite_code();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM pots WHERE invite_code = candidate);
    END LOOP;
    UPDATE pots SET invite_code = candidate WHERE id = pot.id;
  END LOOP;
END
$$;

-- --- 3. CONTRACT: now every row has a value, enforce the guarantees -------
ALTER TABLE pots ALTER COLUMN invite_code SET NOT NULL;
CREATE UNIQUE INDEX pots_invite_code_key ON pots (invite_code);

COMMENT ON COLUMN pots.invite_code IS
  'Short shareable code. The only way a non-member discovers a pot — GET /pots returns only pots you already belong to.';
