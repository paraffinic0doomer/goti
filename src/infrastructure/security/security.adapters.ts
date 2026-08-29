import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Algorithm, hash, verify } from '@node-rs/argon2';

import {
  AccessTokenClaims,
  IssuedToken,
  PasswordHasherPort,
  TokenIssuerPort,
} from '../../application/ports/security.port';

/**
 * Argon2id parameters.
 *
 * WHY ARGON2ID and not bcrypt or a plain hash:
 *   - It is MEMORY-HARD. bcrypt is CPU-hard only, so a GPU or ASIC farm
 *     parallelises it cheaply. Argon2id forces each guess to allocate 19 MiB,
 *     which is what makes large-scale offline cracking expensive rather than
 *     merely slow.
 *   - The `id` variant resists both side-channel attacks (from argon2i) and
 *     GPU cracking (from argon2d).
 *   - A fast hash — SHA-256, MD5 — is not a password hash at all. Modern
 *     hardware computes billions per second, so a leaked table of them is a
 *     leaked table of passwords.
 *
 * These are the OWASP-recommended minimums. They are versioned by `needsRehash`
 * so raising them later upgrades existing users transparently at next login.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Password hashing.
 *
 * The salt is generated per password and embedded in the output string by
 * argon2 itself — there is no separate salt column, and no opportunity to
 * forget one. Two users with the same password get different hashes, so a
 * leaked table reveals nothing about which accounts share a password.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasherPort {
  private readonly logger = new Logger(Argon2PasswordHasher.name);

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verifies a password.
   *
   * argon2's `verify` compares in constant time with respect to the hash, so
   * it cannot be used as a timing oracle. A malformed or corrupted stored hash
   * returns FALSE rather than throwing — an exception here would turn a bad row
   * into a 500 that tells an attacker something interesting.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, ARGON2_OPTIONS);
    } catch (error) {
      this.logger.warn(`Password verification failed on a malformed hash: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Whether the stored hash used weaker parameters than current policy.
   *
   * Without this, hashes created today keep today's cost forever while hardware
   * gets faster — the protection decays silently. Login is the only moment the
   * plaintext is legitimately in hand, so it is the only place to upgrade.
   */
  needsRehash(storedHash: string): boolean {
    // @node-rs/argon2 embeds the algorithm, version and cost parameters in the
    // PHC string but does not expose a needsRehash helper. Compare that metadata
    // to policy without ever handling the salt or digest.
    const parameters = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!parameters) return true;

    const [, version, memoryCost, timeCost, parallelism] = parameters;
    return (
      Number(version) !== 19 ||
      Number(memoryCost) !== ARGON2_OPTIONS.memoryCost ||
      Number(timeCost) !== ARGON2_OPTIONS.timeCost ||
      Number(parallelism) !== ARGON2_OPTIONS.parallelism
    );
  }
}

/**
 * JWT issuance and verification.
 *
 * SECURITY DECISIONS:
 *
 *  1. HS256 WITH A SECRET FROM THE ENVIRONMENT. The service refuses to start
 *     without one — see `JwtModule` registration. A default secret is worse
 *     than no authentication, because it looks like authentication.
 *
 *  2. SHORT EXPIRY (1 hour). A JWT cannot be revoked; the only bound on a
 *     stolen token is its lifetime. Long-lived access tokens are the single
 *     most common auth mistake in this shape of system. Refresh tokens, which
 *     CAN be revoked because they are stored, are the follow-up.
 *
 *  3. MINIMAL CLAIMS. Subject and phone only. A JWT is signed, not encrypted —
 *     anyone holding it can read the payload. Balances, roles and email
 *     addresses do not belong in one.
 *
 *  4. NO AUTHORISATION DATA IN THE TOKEN. Ownership is checked against the
 *     database at use time. A token minted before a wallet was frozen must not
 *     still assert that it is active.
 *
 *  5. `verify` RETURNS NULL RATHER THAN THROWING. Expired, tampered and
 *     malformed are all "not authenticated" — distinguishing them for the
 *     caller only helps an attacker probe.
 */
@Injectable()
export class JwtTokenIssuer implements TokenIssuerPort {
  private readonly logger = new Logger(JwtTokenIssuer.name);
  private readonly expiresInSeconds: number;

  constructor(private readonly jwt: JwtService) {
    this.expiresInSeconds = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 3_600);
    if (!Number.isInteger(this.expiresInSeconds) || this.expiresInSeconds <= 0) {
      throw new Error('JWT_EXPIRES_IN_SECONDS must be a positive integer.');
    }
  }

  async issue(claims: Pick<AccessTokenClaims, 'sub' | 'phone'>): Promise<IssuedToken> {
    const accessToken = await this.jwt.signAsync(
      { sub: claims.sub, phone: claims.phone },
      { expiresIn: this.expiresInSeconds },
    );

    return { accessToken, expiresInSeconds: this.expiresInSeconds, tokenType: 'Bearer' };
  }

  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
      if (
        typeof claims.sub !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sub) ||
        typeof claims.phone !== 'string' ||
        !/^\+8801[3-9]\d{8}$/.test(claims.phone)
      ) {
        return null;
      }
      return claims;
    } catch (error) {
      // Debug, not warn: expired tokens are ordinary traffic, and logging them
      // at warning level buries the failures that actually matter.
      this.logger.debug(`Token rejected: ${(error as Error).message}`);
      return null;
    }
  }
}
