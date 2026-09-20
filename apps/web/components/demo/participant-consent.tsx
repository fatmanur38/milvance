'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { describeApiError } from '@/lib/api/client';
import { api, queryKeys } from '@/lib/api/queries';
import { Button, Card } from '../ui/primitives';

/**
 * Consent to be counted as an external participant.
 *
 * Opt-in, reversible, and deliberately empty of anything personal: a wallet
 * address and a yes or no. It records permission, not activity — what someone
 * actually did is in the contract's events, and any public number has to come
 * from there.
 *
 * Saying "I'm on the Milvance team" only ever removes a wallet from external
 * counts, and it cannot be undone from here.
 */
export function ParticipantConsent({ wallet }: { wallet: string | undefined }) {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: queryKeys.participant(wallet ?? ''),
    queryFn: () => api.participant(wallet as string),
    enabled: wallet !== undefined,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (input: { consentToCount: boolean; isTeam?: boolean }) =>
      api.recordParticipant({ walletAddress: wallet as string, ...input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.participant(wallet ?? '') });
    },
  });

  if (wallet === undefined) return null;
  const consented = state.data?.consentToCount === true;
  const isTeam = state.data?.isTeam === true;

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Counting you</h2>
        <p className="text-sm text-muted">
          Milvance would like to count this wallet as someone outside the team who used the product.
          We store your wallet address and your answer — no name, no contact, nothing else.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={save.isPending}
          onClick={() => save.mutate({ consentToCount: !consented })}
        >
          {consented ? 'Stop counting me' : 'Count me'}
        </Button>
        {!isTeam && (
          <Button
            variant="secondary"
            disabled={save.isPending}
            onClick={() => save.mutate({ consentToCount: consented, isTeam: true })}
          >
            I&rsquo;m on the Milvance team
          </Button>
        )}
        <span className="text-sm text-muted">
          {isTeam
            ? 'Marked as team — excluded from external counts.'
            : consented
              ? 'Counted as an external participant.'
              : 'Not counted.'}
        </span>
      </div>
      {save.isError && (
        <p className="text-sm text-danger" role="alert">
          {describeApiError(save.error)}
        </p>
      )}
      <p className="text-xs text-muted">
        Consent is not evidence of use. Any public number comes from what the contract recorded, not
        from this button.
      </p>
    </Card>
  );
}
