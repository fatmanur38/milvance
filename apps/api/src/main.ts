import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { loadConfig } from './config';

/**
 * API entrypoint.
 *
 * Serves read models and off-chain metadata. It does not run the indexer —
 * that is a separate process (`indexer.main.ts`) so a slow backfill cannot
 * stall HTTP, and so two workers cannot be started by accident just by scaling
 * the web tier.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new SafeExceptionFilter());
  // Evidence arrives as base64 in JSON. The parser limit must account for
  // encoding overhead; the controller then enforces the decoded byte limit.
  app.useBodyParser('json', { limit: `${Math.ceil((config.evidence.maxBytes * 4) / 3) + 8192}b` });
  app.use(
    (
      request: { method: string; originalUrl: string },
      response: {
        setHeader(name: string, value: string): void;
        on(event: string, callback: () => void): void;
        statusCode: number;
      },
      next: () => void,
    ) => {
      const requestId = randomUUID();
      response.setHeader('X-Request-ID', requestId);
      response.on('finish', () => {
        new Logger('http').log(
          JSON.stringify({
            requestId,
            method: request.method,
            path: request.originalUrl.split('?')[0],
            status: response.statusCode,
          }),
        );
      });
      next();
    },
  );
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.WEB_URL ?? 'http://localhost:3000' });

  await app.listen(config.port);
  // The DATABASE_URL is deliberately absent from this line: it can carry a password.
  new Logger('bootstrap').log(
    `Milvance API on :${config.port} — derived read model for ${config.stellar.contractId} (${config.stellar.network})`,
  );
}

void bootstrap();
