-- Security questions: the knowledge factor that survives a stolen password.
--
-- Purely ADDITIVE — three enums and two tables. No existing column changes, so
-- no reset is required and migration history stays intact.

CREATE TYPE "SecurityQuestionKey" AS ENUM (
  'FIRST_SCHOOL', 'BEST_FRIEND_NAME', 'BIRTH_CITY',
  'MOTHERS_MAIDEN_NAME', 'FIRST_PET', 'CHILDHOOD_NICKNAME'
);
CREATE TYPE "SecurityChallengePurpose" AS ENUM ('TRANSFER', 'UNFREEZE');
CREATE TYPE "SecurityChallengeStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'EXPIRED');

CREATE TABLE "security_answers" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "question_key" "SecurityQuestionKey" NOT NULL,
  "answer_hash" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "security_answers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "security_answers_user_id_question_key_key"
  ON "security_answers"("user_id", "question_key");
CREATE INDEX "security_answers_user_id_idx" ON "security_answers"("user_id");

CREATE TABLE "security_challenges" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "question_key" "SecurityQuestionKey" NOT NULL,
  "purpose" "SecurityChallengePurpose" NOT NULL,
  "status" "SecurityChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "bound_idempotency_key" VARCHAR(64),
  "bound_amount_poisha" BIGINT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "ip_address" INET,
  "correlation_id" UUID,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "security_challenges_user_purpose_status_idx"
  ON "security_challenges"("user_id", "purpose", "status", "created_at" DESC);
CREATE INDEX "security_challenges_bound_idempotency_key_idx"
  ON "security_challenges"("bound_idempotency_key");

ALTER TABLE "security_answers" ADD CONSTRAINT "security_answers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_challenges" ADD CONSTRAINT "security_challenges_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Hardening -------------------------------------------------------------

-- A challenge must expire, and a resolved one must say when.
ALTER TABLE "security_challenges"
  ADD CONSTRAINT security_challenges_resolution_matches_status
  CHECK (
    (status = 'PENDING' AND resolved_at IS NULL)
    OR (status <> 'PENDING' AND resolved_at IS NOT NULL)
  );

ALTER TABLE "security_challenges"
  ADD CONSTRAINT security_challenges_attempts_non_negative
  CHECK (attempt_count >= 0);

-- A TRANSFER challenge must be bound to the transfer it authorises; an UNFREEZE
-- challenge has nothing to bind to. Unbound transfer challenges would be
-- reusable across amounts, which is the whole attack this prevents.
ALTER TABLE "security_challenges"
  ADD CONSTRAINT security_challenges_transfer_is_bound
  CHECK (
    (purpose = 'TRANSFER' AND bound_idempotency_key IS NOT NULL AND bound_amount_poisha IS NOT NULL)
    OR (purpose = 'UNFREEZE' AND bound_idempotency_key IS NULL AND bound_amount_poisha IS NULL)
  );

-- The pending-challenge lookup. Tiny: challenges resolve within minutes.
CREATE INDEX idx_security_challenges_pending
  ON security_challenges (user_id, expires_at)
  WHERE status = 'PENDING';

GRANT SELECT, INSERT, UPDATE ON security_answers    TO goti_app;
GRANT SELECT, INSERT, UPDATE ON security_challenges TO goti_app;

COMMENT ON TABLE security_answers IS
  'Argon2id-hashed answers. Never plaintext — people reuse these across sites.';
COMMENT ON TABLE security_challenges IS
  'One question, one action. Bound to a specific transfer so a pass cannot be reused for a larger one.';
