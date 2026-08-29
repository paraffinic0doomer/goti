import { Controller, Get } from '@nestjs/common';

import { GetUserProfileUseCase } from '../../../application/use-cases/user.use-cases';
import { AuthenticatedUser, CurrentUser } from '../http.plumbing';

@Controller('users')
export class UserController {
  constructor(private readonly getProfile: GetUserProfileUseCase) {}

  @Get('profile')
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.getProfile.execute(user.userId);
  }
}
