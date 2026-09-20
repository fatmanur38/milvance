'use client';

import { useMemo } from 'react';

import { qrMatrix, qrPayloadSafety, qrSvgPath } from '@/lib/demo/qr';

/**
 * An invite link as a scannable code.
 *
 * Rendered as an SVG from a deterministic matrix — no canvas, no image host,
 * nothing fetched. The payload is checked before it is drawn: a link carrying
 * anything beyond the known invite parameters refuses to become a QR code
 * rather than putting it on a screen in a room full of people.
 */
export function QrCode({ payload, label }: { payload: string; label: string }) {
  const result = useMemo(() => {
    const safety = qrPayloadSafety(payload);
    if (!safety.safe) return { error: safety.reason } as const;
    try {
      const matrix = qrMatrix(payload);
      return { matrix, path: qrSvgPath(matrix) } as const;
    } catch {
      return { error: 'This link could not be turned into a QR code.' } as const;
    }
  }, [payload]);

  if ('error' in result) {
    return (
      <p className="text-sm text-danger" role="alert">
        {result.error}
      </p>
    );
  }

  // One module of quiet zone on each side keeps scanners happy on a screen.
  const span = result.matrix.size + 2;
  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      className="h-44 w-44 rounded-lg bg-white p-1"
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <g transform="translate(1 1)" fill="#000000">
        <path d={result.path} />
      </g>
    </svg>
  );
}
