/** Logical cache keys shared by readers and the transaction invalidator. */
export const ApplicationCacheKeys = {
  walletBalanceByUser(userId: string): string {
    return `cache:user:${userId}:wallet_balance`;
  },

  recentTransactionsByWallet(walletId: string): string {
    return `cache:wallet:${walletId}:recent_transactions`;
  },
} as const;
