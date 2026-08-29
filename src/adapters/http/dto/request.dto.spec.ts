import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateMoneyRequestDto, SendMoneyRequestDto } from './request.dto';

describe('money DTO identifier validation', () => {
  const receiverId = '10000000-0001-7000-8000-000000000001';

  it('accepts exactly one receiver and the public amount field', async () => {
    const dto = plainToInstance(SendMoneyRequestDto, {
      receiverId,
      amount: 50_00,
      idempotencyKey: 'transfer_123',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects both receiver identifiers', async () => {
    const dto = plainToInstance(SendMoneyRequestDto, {
      receiverId,
      receiverPhone: '+8801712345678',
      amount: 50_00,
      idempotencyKey: 'transfer_123',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'receiverIdentifierCheck')).toBe(true);
  });

  it('rejects a money request without a payer', async () => {
    const dto = plainToInstance(CreateMoneyRequestDto, {
      amount: 50_00,
      idempotencyKey: 'request_123',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'payerIdentifierCheck')).toBe(true);
  });
});
