'use client';

import { useState } from 'react';

import { describeApiError } from '@/lib/api/client';
import { api, useMilestoneEvidence } from '@/lib/api/queries';
import type { Milestone } from '@/lib/api/schemas';
import {
  DOCUMENT_LABELS,
  MAX_EVIDENCE_BYTES,
  sha256Hex,
  shortDigest,
  toBase64,
} from '@/lib/evidence/hash';
import { isBusy } from '@/lib/tx/lifecycle';
import { useContractTransaction } from '@/lib/tx/use-transaction';

import { ActionPanel } from '../orders/action-panel';
import { Badge, Button, Field, inputClass, Loading, Notice } from '../ui/primitives';

/**
 * Evidence already on record for a milestone. Visible to every party: the
 * commitment is public on Stellar, and the metadata describes it.
 */
export function EvidenceList({ milestone }: { milestone: Milestone }) {
  const evidence = useMilestoneEvidence(milestone.milestoneId);
  if (evidence.isPending) return <Loading label="Loading evidence…" />;
  if (evidence.isError)
    return <p className="text-sm text-danger">{describeApiError(evidence.error)}</p>;

  const { onChainEvidenceHash, documents } = evidence.data;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        On-chain commitment:{' '}
        {onChainEvidenceHash ? (
          <code title={onChainEvidenceHash} className="font-mono text-xs">
            {shortDigest(onChainEvidenceHash)}
          </code>
        ) : (
          <span className="text-muted">none yet</span>
        )}
      </p>
      {documents.length === 0 ? (
        <p className="text-muted">
          {onChainEvidenceHash
            ? 'The document was shared outside Milvance; only its fingerprint is on Stellar.'
            : 'No documents uploaded yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {documents.map((document) => (
            <li key={document.contentHash} className="flex flex-wrap items-center gap-2">
              {/* Filenames and labels are user-supplied; React renders them as text. */}
              <span>{document.documentLabel ?? 'Document'}</span>
              <span className="text-muted">· {document.filename}</span>
              <code title={document.contentHash} className="font-mono text-xs text-muted">
                {shortDigest(document.contentHash)}
              </code>
              {document.contentHash === onChainEvidenceHash ? (
                <Badge tone="success">Matches commitment</Badge>
              ) : (
                <Badge>Not the current commitment</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Supplier: hash a real document, record its metadata, then commit the digest. */
export function SubmitEvidenceAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  const [label, setLabel] = useState<string>(DOCUMENT_LABELS[0]);
  const [file, setFile] = useState<File | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const choose = async (next: File | null) => {
    setFile(next);
    setDigest(null);
    setProblem(null);
    if (next === null) return;
    if (next.size === 0) return setProblem('That file is empty.');
    if (next.size > MAX_EVIDENCE_BYTES) return setProblem('That file is larger than 25 MB.');
    setDigest(await sha256Hex(await next.arrayBuffer()));
  };

  return (
    <ActionPanel
      title="Submit evidence"
      who="You, as supplier"
      tx={tx}
      review={
        digest && (
          <>
            Only this fingerprint is written to Stellar:{' '}
            <code className="font-mono">{shortDigest(digest)}</code>. The document itself stays
            off-chain. Stellar does not read documents — the order’s attestor reviews the real
            evidence and decides whether the milestone is complete.
          </>
        )
      }
    >
      <ol className="list-decimal pl-5 text-sm text-muted">
        <li>Choose the document.</li>
        <li>Milvance fingerprints the exact bytes (SHA-256).</li>
        <li>Your wallet commits that fingerprint on Stellar.</li>
        <li>The attestor reviews the document against it.</li>
      </ol>
      <div className="flex flex-wrap gap-4">
        <Field label="Document type">
          <select className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)}>
            {DOCUMENT_LABELS.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </Field>
        <Field label="Document" error={problem}>
          <input
            type="file"
            className="text-sm"
            onChange={(event) => void choose(event.target.files?.[0] ?? null)}
          />
        </Field>
      </div>
      {digest && (
        <p className="text-sm">
          Fingerprint: <code className="break-all font-mono text-xs">{digest}</code>
        </p>
      )}
      <Button
        className="w-fit"
        disabled={file === null || digest === null || uploading || isBusy(tx.state)}
        onClick={async () => {
          if (file === null || digest === null) return;
          setProblem(null);
          setUploading(true);
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // The server re-hashes the bytes and must reach the same digest,
            // or it rejects the upload before anything is committed on chain.
            const stored = await api.uploadEvidence({
              contentBase64: toBase64(bytes),
              expectedHash: digest,
              filename: file.name,
              mimeType: file.type === '' ? 'application/octet-stream' : file.type,
              documentLabel: label,
              uploadedBy: tx.walletAddress,
              milestoneId: milestone.milestoneId,
            });
            if (stored.contentHash !== digest) {
              setProblem('The stored fingerprint did not match. Nothing was committed.');
              return;
            }
          } catch (error) {
            setProblem(describeApiError(error));
            return;
          } finally {
            setUploading(false);
          }
          await tx.run({
            kind: 'submit-evidence',
            milestoneId: milestone.milestoneId,
            evidenceHash: digest,
          });
        }}
      >
        {uploading ? 'Storing document…' : 'Review in wallet'}
      </Button>
    </ActionPanel>
  );
}

/** Attestor: compare a received copy to the commitment, then verify. */
export function VerifyMilestoneAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  const [checked, setChecked] = useState<'match' | 'mismatch' | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const commitment = milestone.evidenceHash;
  if (commitment === null) return null;

  return (
    <ActionPanel
      title="Verify this milestone"
      who="You, as attestor"
      tx={tx}
      review={
        <>
          You are confirming that the real-world evidence behind fingerprint{' '}
          <code className="font-mono">{shortDigest(commitment)}</code> shows this milestone is
          complete. Stellar records your verification; it cannot inspect goods or documents itself.
        </>
      }
    >
      <Field
        label="Check a copy you received (optional)"
        hint="Hashed in your browser; nothing is uploaded."
      >
        <input
          type="file"
          className="text-sm"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return setChecked(null);
            const digest = await sha256Hex(await file.arrayBuffer());
            setChecked(digest === commitment ? 'match' : 'mismatch');
          }}
        />
      </Field>
      {checked === 'match' && (
        <Notice tone="success">This file is exactly the document the supplier committed.</Notice>
      )}
      {checked === 'mismatch' && (
        <Notice tone="danger">
          This file is NOT the committed document. Its fingerprint differs from the one on Stellar.
        </Notice>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
        I have reviewed the real-world evidence and it shows this milestone is complete.
      </label>
      <Button
        className="w-fit"
        disabled={!reviewed || checked === 'mismatch' || isBusy(tx.state)}
        onClick={() =>
          void tx.run({
            kind: 'verify-milestone',
            milestoneId: milestone.milestoneId,
            evidenceHash: commitment,
          })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}
