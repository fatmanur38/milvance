import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { HealthController } from '../health/health.controller';
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
});
