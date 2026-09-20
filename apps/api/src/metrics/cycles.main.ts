import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { deriveCycles, storeCycles, verifyReportedLegs } from './local-payment-cycles';

/**
 * Local-payment cycle verification.
 *
 * Modes:
 *
 *   verify   check reported Anchor legs against Stellar, then rebuild cycles
 *   recheck  re-check every leg, including ones already judged
 *   derive   rebuild cycles from stored verdicts only (no network)
 *   status   print the current cycles and exit
 *
 * Kept out of the request path deliberately. Verification talks to Horizon, so
 * it is an explicit operation whose verdict is written down and auditable,
 * rather than a network call hiding inside a page load. Serving metrics never
 * needs this process to be running: an unchecked leg simply supports no cycle.
 */
type Mode = 'verify' | 'recheck' | 'derive' | 'status';

const MODES: readonly Mode[] = ['verify', 'recheck', 'derive', 'status'];

/** Horizon over plain fetch. Read-only, and no credential is ever attached. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`horizon responded ${response.status}`);
  return response.json();
}

async function main(): Promise<void> {
  const logger = new Logger('cycles');
  const requested = process.argv[2] ?? 'verify';
  if (!MODES.includes(requested as Mode)) {
    throw new Error(`Unknown mode '${requested}'. Expected one of: ${MODES.join(', ')}`);
  }
  const mode = requested as Mode;

  const config = loadConfig();
  const prisma = new PrismaService(config.databaseUrl);
  await prisma.$connect();
  const scope = { network: config.stellar.network, contractId: config.stellar.contractId };

  try {
    if (mode === 'verify' || mode === 'recheck') {
      const tally = await verifyReportedLegs(prisma, config.stellar, fetchJson, {
        recheckAll: mode === 'recheck',
      });
      logger.log(
        `legs checked=${tally.checked} confirmed=${tally.confirmed} mismatched=${tally.mismatched} unverifiable=${tally.unverifiable}`,
      );
    }

    const cycles = await deriveCycles(prisma, scope);
    if (mode !== 'status') {
      await storeCycles(prisma, scope, cycles);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          counted: cycles.filter((cycle) => cycle.verified).length,
          candidates: cycles.length,
          cycles: cycles.map((cycle) => ({
            milestoneId: cycle.milestoneId.toString(),
            counted: cycle.verified,
            link: cycle.link,
            missing: cycle.missing,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  new Logger('cycles').error(error instanceof Error ? error.message : 'cycle pass failed');
  process.exitCode = 1;
});
