/**
 * Security ports — owned by the application layer.
 *
 * Hashing and token issuance are INFRASTRUCTURE concerns: which KDF, which
 * signing algorithm, where the secret comes from. Behind these interfaces the
 * use cases only know "verify this credential" and "issue a token for this
 * user", which is what lets the algorithm be replaced — argon2id today, whatever
 * supersedes it in five years — without a single use case changing.
 */

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');

export interface PasswordHasherPort {
  hash(plaintext: string): Promise<string>;

  /**
   * Verifies a password against a stored hash.
   *
   * MUST be constant-time with respect to the hash contents. A comparison that
   * short-circuits on the first differing byte leaks information about the hash
   * through response timing.
   */
  verify(hash: string, plaintext: string): Promise<boolean>;

  /**
   * Whether a stored hash used weaker parameters than the current policy.
   *
   * KDF cost parameters must rise as hardware gets faster. Without this, hashes
   * created in 2026 stay at 2026 cost forever, and the protection silently
   * decays. Re-hashing happens transparently at the next successful login,
   * where the plaintext is legitimately in hand.
   */
  needsRehash(hash: string): boolean;
}

export interface AccessTokenClaims {
  /** Subject — the user id. */
  readonly sub: string;
  readonly phone: string;
  /** Issued-at and expiry, in seconds. Set by the issuer, never by a caller. */
  readonly iat?: number;
  readonly exp?: number;
}

export interface IssuedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly tokenType: 'Bearer';
}

export interface TokenIssuerPort {
  issue(claims: Pick<AccessTokenClaims, 'sub' | 'phone'>): Promise<IssuedToken>;

  /** Returns the claims, or null if the token is invalid, expired or tampered with. */
  verify(token: string): Promise<AccessTokenClaims | null>;
}
