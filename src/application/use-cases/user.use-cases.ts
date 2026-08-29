import { Inject, Injectable } from '@nestjs/common';

import { UserNotFoundError } from '../../domain/errors/domain-errors';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../ports/repositories.port';

export interface UserProfileView {
  readonly userId: string;
  readonly phone: string;
  readonly displayName: string;
  readonly status: string;
  readonly walletId: string | null;
}

/** Returns only authenticated-account data; credentials never leave persistence. */
@Injectable()
export class GetUserProfileUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(userId: string): Promise<UserProfileView> {
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    return {
      userId: user.id,
      phone: user.phone,
      displayName: user.displayName,
      status: user.status,
      walletId: user.walletId,
    };
  }
}
