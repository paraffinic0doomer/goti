import type { CachePort } from '../ports/cache.port';
import type { UserRepositoryPort, WalletRepositoryPort } from '../ports/repositories.port';
import { GetWalletUseCase } from './wallet.use-cases';

describe('GetWalletUseCase balance cache', () => {
  it('serves a cache hit without querying PostgreSQL', async () => {
    const wallets = { findByUserId: jest.fn() } as unknown as WalletRepositoryPort;
    const cache = {
      get: jest.fn().mockResolvedValue({
        walletId: '20000000-0001-7000-8000-000000000001',
        balancePoisha: 123_45n,
        currency: 'BDT',
      }),
    } as unknown as CachePort;
    const users = {} as UserRepositoryPort;

    const result = await new GetWalletUseCase(wallets, users, cache).getBalance(
      '10000000-0001-7000-8000-000000000001',
    );

    expect(result.cached).toBe(true);
    expect(result.balancePoisha).toBe(123_45n);
    expect(wallets.findByUserId).not.toHaveBeenCalled();
  });

  it('loads PostgreSQL on a miss and writes the short-lived display cache', async () => {
    const wallets = {
      findByUserId: jest.fn().mockResolvedValue({
        id: '20000000-0001-7000-8000-000000000001',
        userId: '10000000-0001-7000-8000-000000000001',
        balancePoisha: 123_45n,
        currency: 'BDT',
        status: 'ACTIVE',
        version: 1,
      }),
    } as unknown as WalletRepositoryPort;
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    } as unknown as CachePort;

    const result = await new GetWalletUseCase(
      wallets,
      {} as UserRepositoryPort,
      cache,
    ).getBalance('10000000-0001-7000-8000-000000000001');

    expect(result.cached).toBe(false);
    expect(cache.set).toHaveBeenCalledWith(
      'cache:user:10000000-0001-7000-8000-000000000001:wallet_balance',
      expect.objectContaining({ balancePoisha: 123_45n }),
      5,
    );
  });
});
