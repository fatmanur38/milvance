import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { loadConfig } from './config';
import { allowedOrigins, SECURITY_HEADERS } from './common/http-security';

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
  // Nothing should advertise the framework, and no directory should be
  // browsable: this process serves JSON and nothing else.
  app.disable('x-powered-by');
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
      for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
        response.setHeader(header, value);
      }
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
  app.enableCors({
    // A comma-separated list so a preview deployment can be allowed alongside
    // production without opening the API to every origin on the internet.
    origin: allowedOrigins(process.env.WEB_URL),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    credentials: false,
    maxAge: 86_400,
  });

  // Bind every interface: a container's port mapping cannot reach a process
  // listening only on loopback.
  await app.listen(config.port, '0.0.0.0');
  // The DATABASE_URL is deliberately absent from this line: it can carry a password.
  new Logger('bootstrap').log(
    `Milvance API on :${config.port} — derived read model for ${config.stellar.contractId} (${config.stellar.network})`,
  );
}

void bootstrap();
