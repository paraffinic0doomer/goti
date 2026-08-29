import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PASSWORD_HASHER, TOKEN_ISSUER } from '../../application/ports/security.port';
import { Argon2PasswordHasher, JwtTokenIssuer } from './security.adapters';

/** Binds application security ports to concrete, centrally configured adapters. */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
        }

        return {
          secret,
          signOptions: {
            algorithm: 'HS256' as const,
            issuer: process.env.JWT_ISSUER ?? 'goti-api',
            audience: process.env.JWT_AUDIENCE ?? 'goti-client',
          },
          verifyOptions: {
            algorithms: ['HS256' as const],
            issuer: process.env.JWT_ISSUER ?? 'goti-api',
            audience: process.env.JWT_AUDIENCE ?? 'goti-client',
          },
        };
      },
    }),
  ],
  providers: [
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenIssuer },
  ],
  exports: [PASSWORD_HASHER, TOKEN_ISSUER],
})
export class SecurityModule {}
