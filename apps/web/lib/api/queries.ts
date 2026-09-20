'use client';

import { useQuery } from '@tanstack/react-query';

import { apiRequest } from './client';
import {
  activitySchema,
  evidenceUploadSchema,
  funderOffersSchema,
  indexerStatusSchema,
  milestoneDisputesSchema,
  milestoneEvidenceSchema,
  milestoneFinanceSchema,
  opportunitiesSchema,
  orderListSchema,
  orderWithMilestonesSchema,
  positionsSchema,
  readinessSchema,
} from './schemas';

/**
 * Query keys, in one place.
 *
 * Everything chain-derived lives under the `chain` prefix so a confirmed
 * transaction can invalidate all of it at once: after a write we do not guess
 * which projections changed, we re-read them.
 */
export const queryKeys = {
  chain: ['chain'] as const,
  orders: (participant: string) => ['chain', 'orders', participant] as const,
  order: (orderId: string) => ['chain', 'order', orderId] as const,
  milestoneFinance: (milestoneId: string) =>
    ['chain', 'milestone', milestoneId, 'finance'] as const,
  milestoneEvidence: (milestoneId: string) =>
    ['chain', 'milestone', milestoneId, 'evidence'] as const,
  milestoneDisputes: (milestoneId: string) =>
    ['chain', 'milestone', milestoneId, 'disputes'] as const,
  opportunities: ['chain', 'funding', 'opportunities'] as const,
  funderOffers: (funder: string) => ['chain', 'funding', 'offers', funder] as const,
  positions: (funder: string) => ['chain', 'funding', 'positions', funder] as const,
  activity: ['chain', 'activity'] as const,
  readiness: ['service', 'readiness'] as const,
  indexerStatus: ['service', 'indexer'] as const,
};

const enc = encodeURIComponent;

export const api = {
  orders: (participant: string) =>
    apiRequest(`/orders?participant=${enc(participant)}&limit=200`, orderListSchema),
  order: (orderId: string) => apiRequest(`/orders/${enc(orderId)}`, orderWithMilestonesSchema),
  milestoneFinance: (id: string) =>
    apiRequest(`/milestones/${enc(id)}/finance`, milestoneFinanceSchema),
  milestoneEvidence: (id: string) =>
    apiRequest(`/milestones/${enc(id)}/evidence`, milestoneEvidenceSchema),
  milestoneDisputes: (id: string) =>
    apiRequest(`/milestones/${enc(id)}/disputes`, milestoneDisputesSchema),
  opportunities: () => apiRequest('/funding/opportunities?limit=200', opportunitiesSchema),
  funderOffers: (funder: string) =>
    apiRequest(`/funding/offers?funder=${enc(funder)}&limit=200`, funderOffersSchema),
  positions: (funder: string) =>
    apiRequest(`/funding/positions?funder=${enc(funder)}&limit=200`, positionsSchema),
  activity: () => apiRequest('/activity?limit=100', activitySchema),
  readiness: () => apiRequest('/health/ready', readinessSchema),
  indexerStatus: () => apiRequest('/indexer/status', indexerStatusSchema),
  /**
   * Off-chain evidence metadata. The bytes are hashed and stored off-chain;
   * the digest this returns is what the supplier's WALLET later commits.
   */
  uploadEvidence: (input: {
    contentBase64: string;
    expectedHash: string;
    filename: string;
    mimeType: string;
    documentLabel: string;
    uploadedBy: string;
    milestoneId: string;
  }) =>
    apiRequest('/evidence', evidenceUploadSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
};

export function useOrders(participant: string | undefined) {
  return useQuery({
    queryKey: queryKeys.orders(participant ?? ''),
    queryFn: () => api.orders(participant as string),
    enabled: participant !== undefined,
  });
}

export function useOrder(orderId: string) {
  return useQuery({ queryKey: queryKeys.order(orderId), queryFn: () => api.order(orderId) });
}

export function useMilestoneFinance(milestoneId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.milestoneFinance(milestoneId),
    queryFn: () => api.milestoneFinance(milestoneId),
    enabled,
  });
}

export function useMilestoneEvidence(milestoneId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.milestoneEvidence(milestoneId),
    queryFn: () => api.milestoneEvidence(milestoneId),
    enabled,
  });
}

export function useMilestoneDisputes(milestoneId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.milestoneDisputes(milestoneId),
    queryFn: () => api.milestoneDisputes(milestoneId),
    enabled,
  });
}

export function useOpportunities() {
  return useQuery({ queryKey: queryKeys.opportunities, queryFn: api.opportunities });
}

export function useFunderOffers(funder: string | undefined) {
  return useQuery({
    queryKey: queryKeys.funderOffers(funder ?? ''),
    queryFn: () => api.funderOffers(funder as string),
    enabled: funder !== undefined,
  });
}

export function usePositions(funder: string | undefined) {
  return useQuery({
    queryKey: queryKeys.positions(funder ?? ''),
    queryFn: () => api.positions(funder as string),
    enabled: funder !== undefined,
  });
}

export function useActivity() {
  return useQuery({ queryKey: queryKeys.activity, queryFn: api.activity });
}

/** Polled so the shell notices a stalled indexer without a page reload. */
export function useReadiness() {
  return useQuery({
    queryKey: queryKeys.readiness,
    queryFn: api.readiness,
    refetchInterval: 30_000,
    retry: false,
  });
}
