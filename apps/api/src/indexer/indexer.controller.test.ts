import { describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../config';
import type { IndexerService, IndexerTickResult } from './indexer.service';
import { IndexerController } from './indexer.controller';

/**
 * The scheduled-tick endpoint.
 *
 * It exists because the free deployment has no always-running worker. That
 * makes it the one HTTP route that writes to the read model, so what matters
 * is not that it works but what it refuses: an unauthenticated caller, and any
 * attempt to say WHAT should be indexed.
 */
const SECRET = 'f0d0c7dc4b6f4f8e9a1c2d3e4f5061728394a5b6c7d8e9f0';

function config(cronSecret: string | undefined): ApiConfig {
  return {
    indexer: { tick: { maxPages: 5, maxEvents: 500, maxSeconds: 20 }, cronSecret },
  } as ApiConfig;
}

const RAN: IndexerTickResult = {
  status: 'ran',
  fromLedger: '4760607',
  toLedger: '4770000',
  pagesFetched: 1,
  eventsProcessed: 2,
  eventsProjected: 2,
  duplicatesSkipped: 0,
  caughtUp: true,
  durationMs: 12,
};

/** `null` means "no secret configured" — passing `undefined` would silently
 *  fall back to the default parameter and test the opposite of what it says. */
function controller(cronSecret: string | null = SECRET) {
  const tick = vi.fn().mockResolvedValue(RAN);
  const status = vi.fn().mockResolvedValue({ scannedThroughLedger: '4770000' });
  const indexer = { tick, status } as unknown as IndexerService;
  return {
    controller: new IndexerController(indexer, config(cronSecret ?? undefined)),
    tick,
    status,
  };
}

describe('the scheduled indexer tick', () => {
  it('runs a tick for a caller holding the secret', async () => {
    const { controller: subject, tick } = controller();

    const result = await subject.scheduledTick(`Bearer ${SECRET}`);

    expect(result.status).toBe('ran');
    expect(result.eventsProcessed).toBe(2);
    expect(tick).toHaveBeenCalledOnce();
  });

  it('refuses a caller with no credentials', async () => {
    const { controller: subject, tick } = controller();

    await expect(subject.scheduledTick(undefined)).rejects.toThrow(/Unauthorized/i);
    expect(tick).not.toHaveBeenCalled();
  });

  it('refuses a caller with the wrong secret', async () => {
    const { controller: subject, tick } = controller();

    // Including one that is right up to the last character, and one that
    // presents the secret with no scheme at all.
    await expect(subject.scheduledTick(`Bearer ${SECRET.slice(0, -1)}x`)).rejects.toThrow(
      /Unauthorized/i,
    );
    await expect(subject.scheduledTick(`Bearer ${SECRET.slice(0, 8)}`)).rejects.toThrow(
      /Unauthorized/i,
    );
    await expect(subject.scheduledTick(SECRET)).rejects.toThrow(/Unauthorized/i);
    expect(tick).not.toHaveBeenCalled();
  });

  it('tolerates whitespace around the header, since a vault value often carries it', async () => {
    const { controller: subject } = controller();

    // Both sides are trimmed identically — configuration trims the stored
    // value too — so a secret pasted with a trailing newline works rather than
    // failing in a way nobody can diagnose from a log that must not show it.
    await expect(subject.scheduledTick(`  Bearer ${SECRET}\n`)).resolves.toMatchObject({
      status: 'ran',
    });
  });

  it('is closed, not open, when no secret is configured', async () => {
    // The failure mode to avoid: a missing environment variable quietly
    // turning a privileged endpoint into a public one.
    const { controller: subject, tick } = controller(null);

    await expect(subject.scheduledTick(`Bearer ${SECRET}`)).rejects.toThrow(/not configured/i);
    await expect(subject.scheduledTick(undefined)).rejects.toThrow(/not configured/i);
    expect(tick).not.toHaveBeenCalled();
  });

  it('never tells the caller which ledgers to index', async () => {
    const { controller: subject, tick } = controller();

    await subject.scheduledTick(`Bearer ${SECRET}`);

    // The handler takes one argument — the credential — and passes nothing on.
    // There is no body, no cursor and no ledger range to supply, so a caller
    // cannot aim this at data of its own choosing.
    expect(tick).toHaveBeenCalledWith();
    expect(subject.scheduledTick).toHaveLength(1);
  });

  it('does not leak the secret through the response or the error', async () => {
    const { controller: subject } = controller();

    const ran = JSON.stringify(await subject.scheduledTick(`Bearer ${SECRET}`));
    expect(ran).not.toContain(SECRET);

    const refused = await subject.scheduledTick('Bearer nope').catch((error: unknown) => error);
    expect(JSON.stringify(refused)).not.toContain(SECRET);
  });
});

describe('the public catch-up nudge', () => {
  it('runs a small tick so a signed transaction appears without a minute of waiting', async () => {
    const { controller: subject, tick } = controller();

    const result = await subject.publicCatchUp();

    expect(result.status).toBe('ran');
    // Small on purpose: a nudge, not a backfill anyone can trigger.
    const [limits] = tick.mock.calls[0] as [{ maxPages: number; maxSeconds: number }];
    expect(limits.maxPages).toBeLessThanOrEqual(2);
    expect(limits.maxSeconds).toBeLessThanOrEqual(5);
  });

  it('answers a second caller from the cooldown instead of working again', async () => {
    const { controller: subject, tick } = controller();

    await subject.publicCatchUp();
    const throttled = await subject.publicCatchUp();

    expect(throttled.status).toBe('throttled');
    expect(throttled.eventsProcessed).toBe(0);
    // One tick, however many callers arrive.
    expect(tick).toHaveBeenCalledOnce();
  });

  it('needs no credential, and gets no privilege for it', async () => {
    const { controller: subject, tick } = controller(null);

    // Works with no cron secret configured at all: this route is not that one.
    await expect(subject.publicCatchUp()).resolves.toMatchObject({ status: 'ran' });
    expect(subject.publicCatchUp).toHaveLength(0);
    expect(tick).toHaveBeenCalledOnce();
  });
});
