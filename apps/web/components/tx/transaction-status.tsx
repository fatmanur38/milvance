'use client';

import { STAGE_COPY, type TxState } from '@/lib/tx/lifecycle';

import { Button, ExplorerLink, Notice } from '../ui/primitives';

/**
 * Feedback for one wallet-signed action. Every stage says what is happening
 * and, when something went wrong, what the person can do about it.
 */
export function TransactionStatus({
  state,
  onDismiss,
}: {
  state: TxState;
  onDismiss?: () => void;
}) {
  if (state.stage === 'idle') return null;

  if (state.stage === 'failed') {
    return (
      <Notice
        tone="danger"
        title={`${state.label ?? 'Action'} did not complete`}
        action={
          onDismiss && (
            <Button variant="secondary" className="w-fit" onClick={onDismiss}>
              Dismiss
            </Button>
          )
        }
      >
        <p>{state.failure?.message}</p>
        {state.hash && (
          <p className="mt-1">
            <ExplorerLink hash={state.hash} />
          </p>
        )}
        {state.failure?.detail && (
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-1 break-all">{state.failure.detail}</p>
          </details>
        )}
      </Notice>
    );
  }

  const done = state.stage === 'synced' || state.stage === 'sync-delayed';
  return (
    <Notice
      tone={done ? 'success' : 'progress'}
      title={state.label}
      action={
        done && onDismiss ? (
          <Button variant="secondary" className="w-fit" onClick={onDismiss}>
            Done
          </Button>
        ) : undefined
      }
    >
      <p>{STAGE_COPY[state.stage]}</p>
      {state.hash && (
        <p className="mt-1">
          <ExplorerLink hash={state.hash} />
        </p>
      )}
    </Notice>
  );
}
