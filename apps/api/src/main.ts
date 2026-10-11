import './load-env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { DemoDirector } from './demo/demo-director';
import { env, webOrigins } from './platform/config/env';

async function bootstrap() {
  const environment = env();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: webOrigins(), credentials: true, exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'] });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // OpenAPI sinh từ Zod (DEC-04); chỉ bật ngoài production (mục 16.1)
  if (environment.NODE_ENV !== 'production') {
    const config = new DocumentBuilder().setTitle('WareTrack API').setVersion('1.0').addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, config)));
  }

  await app.listen(environment.PORT);
  app.get(DemoDirector).start(environment.PORT);
  Logger.log(`WareTrack API on http://localhost:${environment.PORT}/api/v1 (docs: /api/docs)`, 'Bootstrap');
}

void bootstrap();
