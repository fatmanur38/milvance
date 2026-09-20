import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { DemoController } from '../demo/demo.controller';
import { HealthController } from '../health/health.controller';
import { IndexerController } from '../indexer/indexer.controller';
import { MetricsController } from '../metrics/metrics.controller';
import { ReadController } from './read.controller';

/**
 * Chain-derived resources are read-only over HTTP.
 *
 * Financial state changes through a user-signed Soroban transaction and nothing
 * else. A route such as `PATCH /milestones/:id { status: 'SETTLED' }` must not
 * exist to be called, so this test reads Nest's own routing metadata and fails
 * the build if any handler on a chain-derived controller accepts anything but
 * GET.
 *
 * Evidence and local-payment metadata are deliberately NOT in this list: they
 * are off-chain metadata with legitimate writes, and neither can change a
 * financial column.
 *
 * The indexer controller is the one exception that proves the rule. Its routes
 * DO change chain-derived rows — that is what indexing is — but never from
 * anything the caller said. It is checked separately below.
 */
const CHAIN_DERIVED_CONTROLLERS = [ReadController, HealthController, MetricsController];

function routes(controller: new (...args: never[]) => unknown) {
  const prototype = controller.prototype as object;
  return (
    Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      // Read descriptors rather than values: invoking a getter on the bare
      // prototype would run it without an instance.
      .map((name) => ({ name, handler: Object.getOwnPropertyDescriptor(prototype, name)?.value }))
      .filter(({ handler }) => typeof handler === 'function')
      .map(({ name, handler }) => ({
        name,
        path: Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined,
        method: Reflect.getMetadata(METHOD_METADATA, handler as object) as
          RequestMethod | undefined,
      }))
      .filter((route) => route.path !== undefined)
  );
}

describe('chain-derived write surface', () => {
  it.each(CHAIN_DERIVED_CONTROLLERS.map((controller) => [controller.name, controller] as const))(
    '%s exposes GET routes only',
    (_name, controller) => {
      const found = routes(controller);
      expect(found.length).toBeGreaterThan(0);
      for (const route of found) {
        expect(route.method, `${controller.name}.${route.name} (${route.path})`).toBe(
          RequestMethod.GET,
        );
      }
    },
  );

  it('actually sees the routes it is guarding', () => {
    // Guards against this test silently passing because metadata moved.
    const paths = routes(ReadController).map((route) => route.path);
    expect(paths).toContain('orders');
    expect(paths).toContain('milestones/:milestoneId/finance');
    expect(paths).toContain('funding/offers');
  });

  /**
   * Trade Lab writes exactly one thing: a wallet's consent to be counted. Its
   * controller is scoped to that resource, so a demo helper can never grow a
   * route that reaches an order, a milestone or a payout.
   */
  it('confines the demo controller to participation consent', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, DemoController) as string;
    expect(controllerPath).toBe('demo/participants');

    for (const route of routes(DemoController)) {
      expect([RequestMethod.GET, RequestMethod.POST]).toContain(route.method);
      // No chain vocabulary anywhere in its routing.
      expect(`${controllerPath}/${route.path ?? ''}`).not.toMatch(
        /order|milestone|funding|settle|refund|evidence/i,
      );
    }
  });
});

describe('the indexer write surface', () => {
  /** Nest's parameter decorator for a request body. */
  const BODY_PARAM = 3;

  it('accepts no request body on any route that advances the read model', () => {
    // These two routes write chain-derived rows, so the guarantee cannot be
    // "no writes". It is narrower and stronger: there is nowhere to put an
    // event. Every value they store is read from the configured Stellar RPC,
    // so a caller cannot describe a settlement that the contract never made.
    const args =
      (Reflect.getMetadata(ROUTE_ARGS_METADATA, IndexerController) as
        Record<string, unknown> | undefined) ?? {};

    const bodyParams = Object.keys(args).filter((key) => key.startsWith(`${BODY_PARAM}:`));
    expect(bodyParams).toEqual([]);
  });

  it('exposes no route that rewinds a cursor or drops a read model', () => {
    // `replay` and `reset` exist, and they stay on the CLI. Over HTTP there is
    // no way to make the indexer forget what it has seen.
    const paths = routes(IndexerController).map((route) => route.path);
    expect(paths).toEqual(['internal/indexer/tick', 'indexer/catch-up']);
    for (const path of paths) {
      expect(path).not.toMatch(/replay|reset|rewind|cursor/i);
    }
  });
});
