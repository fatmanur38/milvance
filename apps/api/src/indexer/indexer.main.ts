import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { IndexerService, redactError } from './indexer.service';

/**
 * Standalone indexer process.
 *
 * Modes:
 *
 *   once    catch up to chain head and exit (used by CI and the live proof)
 *   watch   catch up, then keep polling
 *   status  print cursor state and exit
 *   replay  drop derived read models, rewind the cursor, then rebuild
 *
 * `replay` never touches the chain. Rebuilding is purely local, which is the
 * property that makes PostgreSQL disposable and Soroban authoritative.
 */
type Mode = 'once' | 'watch' | 'status' | 'replay';

const MODES: readonly Mode[] = ['once', 'watch', 'status', 'replay'];

function parseMode(argv: readonly string[]): Mode {
  const requested = argv[2] ?? 'once';
  if (!MODES.includes(requested as Mode)) {
    throw new Error(`Unknown mode '${requested}'. Expected one of: ${MODES.join(', ')}`);
  }
  return requested as Mode;
}

async function main(): Promise<void> {
  const logger = new Logger('indexer');
  const mode = parseMode(process.argv);
  const config = loadConfig();
  const prisma = new PrismaService(config.databaseUrl);
  await prisma.$connect();
  const indexer = new IndexerService(prisma, config);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
    logger.log('shutdown requested; finishing the current batch');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await indexer.ensureCursor();

    if (mode === 'status') {
      const status = await indexer.status();
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }

    if (mode === 'replay') {
      logger.warn('replay: dropping derived read models and rebuilding from chain');
      await indexer.reset();
    }

    let result = await indexer.catchUp();
    while (!result.caughtUp && !stopping) {
      result = await indexer.catchUp();
    }
    logger.log(
      `indexer pass: caughtUp=${result.caughtUp} pages=${result.pagesFetched} ingested=${result.eventsIngested} projected=${result.eventsProjected} duplicates=${result.duplicatesSkipped}`,
    );

    if (mode === 'watch') {
      const intervalMs = config.indexer.pollIntervalSeconds * 1000;
      while (!stopping) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        if (stopping) {
          break;
        }
        try {
          const pass = await indexer.catchUp();
          if (pass.eventsIngested > 0) {
            logger.log(`ingested ${pass.eventsIngested} new event(s)`);
          }
        } catch (error) {
          // Keep watching: the cursor did not advance past the failure, so the
          // next pass retries the same events.
          logger.error(`poll failed, will retry: ${redactError(error)}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  new Logger('indexer').error(redactError(error));
  process.exitCode = 1;
});
