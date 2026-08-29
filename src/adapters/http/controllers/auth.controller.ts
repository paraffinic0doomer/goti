import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import {
  LoginUserUseCase,
  RegisterUserUseCase,
} from '../../../application/use-cases/auth.use-cases';
import { Audit, Public } from '../http.plumbing';
import type { AuditContext } from '../../../application/services/audit.service';
import { LoginRequestDto, RegisterRequestDto } from '../dto/request.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUserUseCase,
    private readonly loginUser: LoginUserUseCase,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() body: RegisterRequestDto, @Audit() audit: AuditContext) {
    return this.registerUser.execute(body, audit);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginRequestDto, @Audit() audit: AuditContext) {
    return this.loginUser.execute(body, audit);
  }
}
