import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../../platform/config/env';
import { loadJwtKeys } from '../../platform/auth/jwt-keys';
import { AccessGuard } from './access.guard';
import { AccessService } from './access.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        const keys = loadJwtKeys();
        return {
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          signOptions: { algorithm: 'ES256', expiresIn: env().ACCESS_TOKEN_TTL_SECONDS },
          verifyOptions: { algorithms: ['ES256'] },
        };
      },
    }),
  ],
  controllers: [AuthController, UsersController],
  providers: [AccessService, AuthService, { provide: APP_GUARD, useClass: AccessGuard }],
  exports: [AccessService, JwtModule],
})
export class IdentityModule {}
