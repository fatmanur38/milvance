import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import type { Tone } from '@/lib/domain/status';
import { shortAddress } from '@/lib/domain/roles';

/**
 * Small presentational building blocks.
 *
 * Everything here renders text through React, which escapes it. No component
 * in the workspace uses `dangerouslySetInnerHTML`, so a filename or label a
 * user typed can never become markup.
 */

export function Card({
  children,
  className,
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div';
  'aria-label'?: string;
}) {
  return (
    <Tag
      className={cn('rounded-xl border border-border bg-surface p-5 shadow-card', className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-border/60 text-foreground',
  progress: 'bg-protected-soft text-protected',
  attention: 'bg-attention-soft text-attention',
  success: 'bg-capital-soft text-capital',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A read-model hint such as "Past target date". Dashed and labelled so it can
 * never be mistaken for an authoritative contract status.
 */
export function DerivedBadge({ children }: { children: ReactNode }) {
  return (
    <span
      title="Calculated by the workspace from dates and review state. Not a Stellar contract status, and it moves no money."
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-attention px-2.5 py-0.5 text-xs font-medium text-attention"
    >
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground shadow-card hover:opacity-90 active:opacity-100',
  secondary: 'border border-border bg-surface shadow-card hover:border-border-strong',
  danger: 'border border-danger text-danger hover:bg-danger-soft',
  ghost: 'text-muted hover:bg-background hover:text-foreground',
};

export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
        BUTTON_CLASS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  'rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

export function Notice({
  tone = 'neutral',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string | undefined;
  children: ReactNode;
  action?: ReactNode;
}) {
  const border: Record<Tone, string> = {
    neutral: 'border-border bg-surface',
    progress: 'border-protected/30 bg-protected-soft',
    attention: 'border-attention/30 bg-attention-soft',
    success: 'border-capital/30 bg-capital-soft',
    danger: 'border-danger/30 bg-danger-soft',
  };
  return (
    <div
      className={cn('flex flex-col gap-2 rounded-lg border p-4 text-sm', border[tone])}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {title && <p className="font-medium">{title}</p>}
      <div className="text-foreground/90">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border p-8">
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-xl text-sm text-muted">{children}</div>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="animate-pulse text-sm text-muted" role="status">
      {label}
    </p>
  );
}

/** A public address: short in the layout, full on hover and for copy. */
export function Address({ value, you = false }: { value: string; you?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <code title={value} className="font-mono text-xs">
        {shortAddress(value)}
      </code>
      {you && <Badge tone="progress">You</Badge>}
    </span>
  );
}

export function ExplorerLink({ hash, children }: { hash: string; children?: ReactNode }) {
  return (
    <a
      className="text-xs text-accent underline underline-offset-2"
      href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`}
      target="_blank"
      rel="noreferrer"
    >
      {children ?? 'View on Stellar Expert'}
    </a>
  );
}

/** Collapsed technical detail: present for those who want it, out of the way otherwise. */
export function Technical({ children }: { children: ReactNode }) {
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer select-none">Technical details</summary>
      <div className="mt-2 flex flex-col gap-1 break-all">{children}</div>
    </details>
  );
}
