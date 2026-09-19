import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the Migrate connection string out of `schema.prisma`.
 *
 * Only the CLI (migrate, studio) reads this file. The running application builds
 * its own connection through `@prisma/adapter-pg` in `prisma.service.ts`, so
 * exactly one place reads `DATABASE_URL` at runtime.
 *
 * The datasource is attached only when `DATABASE_URL` is actually set. That
 * keeps `prisma generate` working in CI and on a fresh clone, where no database
 * exists, while `prisma migrate` still fails loudly rather than silently
 * migrating some placeholder database.
 *
 * `DATABASE_URL` is never committed with real credentials: `.env.example`
 * carries local development defaults only.
 */
loadDotenv({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
  quiet: true,
});

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(url === undefined || url === '' ? {} : { datasource: { url } }),
});
