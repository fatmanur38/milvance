import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { network, readArtifact, readContractHash, root } from './common.mjs';

const artifact = readArtifact();
if (!artifact || artifact.network !== network)
  throw new Error('Testnet deployment artifact is missing');
if (readContractHash(artifact.contractId) !== artifact.wasmHash) {
  throw new Error('Live contract WASM differs from deployment artifact');
}

const temporary = mkdtempSync(resolve(tmpdir(), 'milvance-'));
const outputDir = resolve(temporary, 'milvance-bindings');
try {
  execFileSync(
    'stellar',
    [
      'contract',
      'bindings',
      'typescript',
      '--contract-id',
      artifact.contractId,
      '--network',
      network,
      '--output-dir',
      outputDir,
      '--overwrite',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const generated = resolve(outputDir, 'src/index.ts');
  const source = readFileSync(generated, 'utf8');
  const domainTypes = [
    'Config',
    'Order',
    'Milestone',
    'FinanceRequest',
    'FundingOffer',
    'FinancePosition',
    'Dispute',
  ];
  if (
    !source.includes('export class Client') ||
    !source.includes(`contractId: "${artifact.contractId}"`) ||
    domainTypes.some((name) => !source.includes(`export interface ${name} {`))
  ) {
    throw new Error('Generated contract spec is missing core Milvance types');
  }
  const destination = resolve(root, 'packages/contract-bindings/src/generated/index.ts');
  mkdirSync(dirname(destination), { recursive: true });
  // The CLI emits spaces on otherwise blank doc lines. Normalize only trailing
  // whitespace so the generated source passes git diff --check unchanged in meaning.
  writeFileSync(destination, source.replace(/[ \t]+$/gm, ''));
  console.log(`Generated bindings from live Testnet contract ${artifact.contractId}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
