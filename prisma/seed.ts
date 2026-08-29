/**
 * ============================================================================
 *  Goti — seed data
 *
 *  THE CENTRAL RULE OF THIS FILE
 *  ---------------------------------------------------------------------------
 *  Opening balances are ISSUED, never assigned.
 *
 *  The naive seed writes `balancePoisha = 10_000_000` straight onto each
 *  wallet. That produces a database where `wallet_balance_drift` is non-empty
 *  and `ledger_conservation_check` is non-zero on the very first run — the
 *  reconciler screams before a single user has done anything, and the team
 *  learns to ignore it. An alarm you have trained yourself to ignore is worse
 *  than no alarm.
 *
 *  So the seed does what the Transaction Engine does: it posts. A SYSTEM
 *  genesis wallet is debited for every taka it issues, each user wallet is
 *  credited, and the system-wide ledger sum stays exactly 0 from row one. The
 *  genesis wallet's balance ends at the negative of all money in circulation,
 *  which is both correct double-entry and a free "how much money exists?"
 *  metric.
 *
 *  Tiers          SEED_TIER=minimal | dev | load   (default: dev)
 *    minimal  2 users. Deterministic fixtures for unit and contract tests.
 *    dev     50 users + sample transfers, requests, flags. Local development.
 *    load    Skeleton only — see the note at loadTier() before using.
 *
 *  Reset          SEED_RESET=true    Truncates and re-seeds. Blocked in prod.
 * ============================================================================
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
//  Money helpers — the unit is in the name so a bare number cannot be mistaken
//  for taka. Mirrors the domain's Money value object (ARCHITECTURE.md §4).
// ---------------------------------------------------------------------------

const POISHA_PER_BDT = 100n;
const bdt = (taka: number): bigint => BigInt(taka) * POISHA_PER_BDT;

/** ARCHITECTURE.md: every user starts with 100,000 BDT of fake money. */
const OPENING_BALANCE = bdt(100_000);

// ---------------------------------------------------------------------------
//  Deterministic IDs
//
//  Fixed UUIDs mean a test can reference `USER_IDS[0]` and get the same row on
//  every machine and every run. Reproducibility beats realism in a seed.
//
//  Production IDs come from the application's IdGenerator port as UUIDv7 —
//  see DATABASE.md "Why no UUID default". These fixtures are shaped like v7
//  (version nibble 7) so they sort the same way real data will.
// ---------------------------------------------------------------------------

const fixedUuid = (kind: number, index: number): string => {
  const h = (n: number, width: number) => n.toString(16).padStart(width, '0');
  return (
    `${h(kind, 8)}-${h(index, 4)}-7000-8000-${h(index, 12)}`
  );
};

const GENESIS_WALLET_ID = '00000000-0000-7000-8000-000000000001';

const userId = (i: number) => fixedUuid(0x10000000, i);
const walletId = (i: number) => fixedUuid(0x20000000, i);
const txId = (i: number) => fixedUuid(0x30000000, i);
const entryId = (i: number) => fixedUuid(0x40000000, i);
const requestId = (i: number) => fixedUuid(0x50000000, i);
const flagId = (i: number) => fixedUuid(0x60000000, i);

// Bangladeshi names and E.164 numbers, so the demo reads like the product
// rather than like `user1@test.com`.
const PEOPLE = [
  'Rahim Uddin', 'Karima Begum', 'Tanvir Hasan', 'Nusrat Jahan', 'Shakib Al Amin',
  'Farhana Akter', 'Imran Kabir', 'Sadia Islam', 'Rezaul Karim', 'Mitali Roy',
  'Arif Chowdhury', 'Sumaiya Haque', 'Jahid Hossain', 'Rubina Sultana', 'Naeem Rahman',
  'Priya Das', 'Sabbir Ahmed', 'Tasnim Nahar', 'Mahfuz Alam', 'Lubna Ferdous',
];

// The modulo guarantees an in-range index; the fallback satisfies
// `noUncheckedIndexedAccess` without an assertion that could hide a real bug
// if PEOPLE were ever emptied.
const personAt = (i: number): string => PEOPLE[i % PEOPLE.length] ?? 'Goti User';
const phoneAt = (i: number) => `+8801${String(700000000 + i).padStart(9, '0')}`;

/**
 * Seeded security answers.
 *
 * Every seeded user answers "dhaka" to all three questions, so a demo can
 * actually pass a challenge. Real registrations hash whatever the user types;
 * this is a fixture, and the hash below is of the literal string "dhaka".
 */
const SEED_ANSWER_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$M3CtweBYX9+4CZoF+3WbMg$5o1Pggz5sLTnEpnzIxYvxrfP7S4/XeA8A6S/raz8vu0';
const SEED_QUESTION_KEYS = ['FIRST_SCHOOL', 'BEST_FRIEND_NAME', 'BIRTH_CITY'] as const;

// A stable stand-in for a real Argon2id hash. Never a real credential.
const PLACEHOLDER_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2VlZG9ubHlub3RyZWFs$c2VlZG9ubHlub3RhcmVhbGhhc2h2YWx1ZQ';

// ---------------------------------------------------------------------------
//  Issuance — the seed's version of a Transaction Engine posting.
//
//  Runs inside one transaction per issuance, exactly like the real engine, and
//  produces the same three artefacts: a Transaction, two balanced LedgerEntry
//  rows, and a TransactionEvent. Pre-marked as published, because there is no
//  one to notify about seed data.
// ---------------------------------------------------------------------------

interface IssuanceArgs {
  tx: Prisma.TransactionClient;
  sequence: number;
  toWalletId: string;
  toUserId: string;
  amountPoisha: bigint;
  genesisBalanceBefore: bigint;
}

async function issue({
  tx, sequence, toWalletId, toUserId, amountPoisha, genesisBalanceBefore,
}: IssuanceArgs): Promise<bigint> {
  const transactionId = txId(sequence);
  const genesisBalanceAfter = genesisBalanceBefore - amountPoisha;
  const now = new Date();

  await tx.transaction.create({
    data: {
      id: transactionId,
      idempotencyKey: `genesis-issuance-${sequence}`,
      initiatorUserId: toUserId,
      type: 'GENESIS_ISSUANCE',
      sourceWalletId: GENESIS_WALLET_ID,
      destWalletId: toWalletId,
      amountPoisha,
      status: 'COMPLETED',
      note: 'Opening balance',
      completedAt: now,
    },
  });

  // Two legs, summing to exactly zero. DEBIT is negative by CHECK constraint.
  await tx.ledgerEntry.createMany({
    data: [
      {
        id: entryId(sequence * 2),
        transactionId,
        walletId: GENESIS_WALLET_ID,
        direction: 'DEBIT',
        amountPoisha: -amountPoisha,
        balanceAfterPoisha: genesisBalanceAfter,
      },
      {
        id: entryId(sequence * 2 + 1),
        transactionId,
        walletId: toWalletId,
        direction: 'CREDIT',
        amountPoisha,
        balanceAfterPoisha: amountPoisha,
      },
    ],
  });

  // The balance projection, updated in the same transaction as the postings —
  // the invariant the whole design rests on.
  await tx.wallet.update({
    where: { id: toWalletId },
    data: { balancePoisha: amountPoisha, version: { increment: 1 } },
  });
  await tx.wallet.update({
    where: { id: GENESIS_WALLET_ID },
    data: { balancePoisha: genesisBalanceAfter, version: { increment: 1 } },
  });

  await tx.transactionEvent.create({
    data: {
      transactionId,
      type: 'TRANSACTION_COMPLETED',
      payload: {
        kind: 'genesis_issuance',
        amountPoisha: amountPoisha.toString(), // BigInt is not JSON-serialisable
        toWalletId,
      },
      publishedAt: now,
    },
  });

  return genesisBalanceAfter;
}

// ---------------------------------------------------------------------------
//  Reset
//
//  TRUNCATE rather than DELETE, deliberately: the append-only triggers block
//  row-level DELETE on ledger_entries, transactions and audit_logs — which is
//  the point of them. TRUNCATE does not fire row triggers, so it remains the
//  one sanctioned way to clear a development database. Hard-blocked outside
//  development.
// ---------------------------------------------------------------------------

async function reset(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SEED_RESET is refused when NODE_ENV=production.');
  }
  console.log('  resetting: truncating all tables');
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      risk_flags, audit_logs, transaction_events, ledger_entries,
      transactions, money_requests, wallets, users
    RESTART IDENTITY CASCADE;
  `);
}

// ---------------------------------------------------------------------------
//  Core fixtures
// ---------------------------------------------------------------------------

async function seedGenesisWallet(): Promise<void> {
  await prisma.wallet.upsert({
    where: { id: GENESIS_WALLET_ID },
    update: {},
    create: {
      id: GENESIS_WALLET_ID,
      userId: null,          // SYSTEM wallets have no owner — CHECK enforced
      type: 'SYSTEM',
      balancePoisha: 0n,     // goes negative as money is issued; exempt from
      status: 'ACTIVE',      // the non-negative CHECK by design
    },
  });
  console.log('  genesis wallet ready');
}

async function seedUsers(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await prisma.user.upsert({
      where: { id: userId(i) },
      update: {},
      create: {
        id: userId(i),
        phone: phoneAt(i),
        displayName: personAt(i),
        email: `${personAt(i).toLowerCase().replace(/\s+/g, '.')}.${i}@example.com`,
        passwordHash: PLACEHOLDER_HASH,
        status: 'ACTIVE',
        wallet: {
          create: {
            id: walletId(i),
            type: 'USER',
            balancePoisha: 0n, // credited by issuance below, never assigned
            status: 'ACTIVE',
          },
        },
        // Security answers are MANDATORY — an account cannot exist without
        // them, so the seed must create them alongside the user or it would
        // produce data the application itself would refuse to create.
        securityAnswers: {
          create: SEED_QUESTION_KEYS.map((questionKey, q) => ({
            id: fixedUuid(0x70000000, i * 10 + q),
            questionKey,
            answerHash: SEED_ANSWER_HASH,
          })),
        },
      },
    });
  }
  console.log(`  ${count} users + wallets created`);
}

async function issueOpeningBalances(count: number): Promise<void> {
  let genesisBalance = 0n;

  for (let i = 0; i < count; i++) {
    const already = await prisma.transaction.findUnique({ where: { id: txId(i) } });
    if (already) continue; // idempotent: issuance already posted

    genesisBalance = await prisma.$transaction((tx) =>
      issue({
        tx,
        sequence: i,
        toWalletId: walletId(i),
        toUserId: userId(i),
        amountPoisha: OPENING_BALANCE,
        genesisBalanceBefore: genesisBalance,
      }),
    );
  }

  console.log(
    `  issued ${OPENING_BALANCE / POISHA_PER_BDT} BDT to ${count} wallets ` +
    `(genesis now ${genesisBalance / POISHA_PER_BDT} BDT)`,
  );
}

// ---------------------------------------------------------------------------
//  Dev-tier extras — enough shape to exercise every read path and every
//  terminal state, without pretending to be production data.
// ---------------------------------------------------------------------------

async function seedMoneyRequests(): Promise<void> {
  const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

  const rows: Prisma.MoneyRequestCreateManyInput[] = [
    // Open, awaiting the payer — the inbox case.
    { id: requestId(0), idempotencyKey: 'req-0', requesterUserId: userId(1),
      payerUserId: userId(0), amountPoisha: bdt(1_500), note: 'Lunch yesterday',
      status: 'REQUESTED', expiresAt: inThreeDays },
    // Declined — resolvedAt required by CHECK.
    { id: requestId(1), idempotencyKey: 'req-1', requesterUserId: userId(2),
      payerUserId: userId(0), amountPoisha: bdt(9_000), note: 'Concert ticket',
      status: 'DECLINED', expiresAt: inThreeDays, resolvedAt: yesterday },
    // Expired by the sweeper. `createdAt` is set explicitly: the default is
    // now(), and `money_requests_expiry_after_creation` requires
    // expires_at > created_at — so an already-expired fixture must also have
    // been created before it expired.
    { id: requestId(2), idempotencyKey: 'req-2', requesterUserId: userId(3),
      payerUserId: userId(1), amountPoisha: bdt(400), note: 'Rickshaw fare',
      status: 'EXPIRED', createdAt: tenDaysAgo, expiresAt: yesterday,
      resolvedAt: yesterday },
    // Withdrawn by the requester.
    { id: requestId(3), idempotencyKey: 'req-3', requesterUserId: userId(0),
      payerUserId: userId(4), amountPoisha: bdt(2_750), note: 'Book order',
      status: 'CANCELLED', expiresAt: inThreeDays, resolvedAt: yesterday },
  ];

  await prisma.moneyRequest.createMany({ data: rows, skipDuplicates: true });
  console.log(`  ${rows.length} money requests (one per terminal state)`);
}

async function seedRiskFlags(): Promise<void> {
  await prisma.riskFlag.createMany({
    data: [
      { id: flagId(0), userId: userId(7), rule: 'velocity.hourly_count',
        severity: 'MEDIUM', status: 'OPEN',
        details: { window: '1h', observed: 23, threshold: 20 } },
      { id: flagId(1), userId: userId(11), rule: 'pattern.circular_transfer',
        severity: 'HIGH', status: 'UNDER_REVIEW',
        details: { cycleLength: 3, participants: 3, totalPoisha: '450000' } },
    ],
    skipDuplicates: true,
  });
  console.log('  2 risk flags (open + under review)');
}

async function seedAuditLog(): Promise<void> {
  await prisma.auditLog.createMany({
    data: [
      { actorUserId: null, actorType: 'SYSTEM', action: 'seed.completed',
        entityType: 'Database', entityId: 'goti',
        after: { tier: process.env.SEED_TIER ?? 'dev' } },
      { actorUserId: userId(0), actorType: 'USER', action: 'auth.login',
        entityType: 'User', entityId: userId(0), ipAddress: '203.0.113.42' },
    ],
  });
  console.log('  audit log entries written');
}

// ---------------------------------------------------------------------------
//  Load tier
//
//  NOT implemented with Prisma on purpose. `createMany` round-trips through the
//  query engine and manages roughly 5–10k rows/sec; 100k users plus their
//  wallets and issuance postings is ~500k rows and takes tens of minutes.
//
//  Use `COPY FROM STDIN` instead — 100k users in a few seconds. Generate the
//  TSV with a script, stream it through `pg`, then run the issuance postings in
//  batched SQL rather than row-by-row. Keep it out of the Prisma seed so that
//  nobody runs it by accident before a demo. See DATABASE.md "Load tier".
// ---------------------------------------------------------------------------

function loadTier(): never {
  throw new Error(
    'SEED_TIER=load is a COPY-based script, not this seed. See DATABASE.md "Load tier".',
  );
}

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tier = process.env.SEED_TIER ?? 'dev';
  console.log(`\nGoti seed — tier: ${tier}\n`);

  if (tier === 'load') loadTier();
  if (process.env.SEED_RESET === 'true') await reset();

  const userCount = tier === 'minimal' ? 2 : 50;

  await seedGenesisWallet();
  await seedUsers(userCount);
  await issueOpeningBalances(userCount);

  if (tier === 'dev') {
    await seedMoneyRequests();
    await seedRiskFlags();
    await seedAuditLog();
  }

  // Prove the seed left the database consistent. If this fails, the seed is
  // wrong — and finding that out here is far cheaper than finding it out from
  // the nightly reconciler.
  const [conservation] = await prisma.$queryRaw<{ net_poisha: bigint }[]>`
    SELECT net_poisha FROM ledger_conservation_check
  `;
  const drift = await prisma.$queryRaw<unknown[]>`
    SELECT wallet_id FROM wallet_balance_drift LIMIT 1
  `;

  if (!conservation) {
    throw new Error('ledger_conservation_check returned no rows — is hardening.sql applied?');
  }
  if (conservation.net_poisha !== 0n) {
    throw new Error(`Ledger does not conserve: net ${conservation.net_poisha} poisha (must be 0)`);
  }
  if (drift.length > 0) {
    throw new Error('wallet_balance_drift is non-empty: a projected balance disagrees with the ledger');
  }

  console.log('\n  ledger conserves (net 0) · no balance drift · seed complete\n');
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
