import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import {
  artifactPath,
  getJson,
  horizonUrl,
  invokeRead,
  network,
  networkPassphrase,
  readArtifact,
  readContractHash,
  root,
  rpcUrl,
  sha256,
  stellar,
  usdcIssuer,
  verifyNetwork,
  verifyUsdcSac,
  wasmHash,
  wasmPath,
} from './common.mjs';

const alias = process.env.MILVANCE_DEPLOYER_ALIAS || 'milvance-deployer';

async function main() {
  verifyNetwork();
  const deployer = stellar(['keys', 'address', alias]);
  if (!/^G[A-Z2-7]{55}$/.test(deployer)) throw new Error('Deployer alias is not a public account');

  const account = await getJson(`${horizonUrl}/accounts/${deployer}`);
  const xlm = account.balances.find((balance) => balance.asset_type === 'native');
  if (!xlm || Number(xlm.balance) < 1) throw new Error('Testnet deployer needs at least 1 XLM');

  const usdcSac = verifyUsdcSac(deployer);
  execFileSync('stellar', ['contract', 'build'], { cwd: root, stdio: 'inherit' });
  const hash = wasmHash();
  const cliHash = stellar(['contract', 'info', 'hash', '--wasm', wasmPath]);
  if (hash !== cliHash) throw new Error('Local WASM hash disagrees with Stellar CLI');

  const salt = sha256(`milvance-core:v1:testnet:${hash}:${deployer}`);
  const expectedId = stellar([
    'contract',
    'id',
    'wasm',
    '--salt',
    salt,
    '--source-account',
    deployer,
    '--network',
    network,
  ]);
  const existing = readArtifact();
  if (existing && (existing.contractId !== expectedId || existing.wasmHash !== hash)) {
    throw new Error(
      'Existing Testnet artifact differs from current deployer/WASM; review before redeploying',
    );
  }

  let deployedNow = false;
  let transactionHash = existing?.deploymentTransactionHash ?? null;
  let deploymentLedger = existing?.deploymentLedger ?? null;
  let deployedAt = existing?.deployedAt ?? null;
  let liveHash;
  if (existing) {
    liveHash = readContractHash(expectedId);
  } else {
    try {
      liveHash = readContractHash(expectedId);
    } catch {
      liveHash = null;
    }
  }
  if (liveHash && liveHash !== hash)
    throw new Error('Expected contract ID contains different WASM');

  if (!liveHash) {
    const beforeSequence = BigInt(account.sequence);
    const result = stellar([
      'contract',
      'deploy',
      '--wasm',
      wasmPath,
      '--optimize=false',
      '--salt',
      salt,
      '--source-account',
      alias,
      '--network',
      network,
      '--',
      '--admin',
      deployer,
      '--usdc',
      usdcSac,
    ]);
    const deployedId = result.match(/\bC[A-Z2-7]{55}\b/)?.[0];
    if (deployedId !== expectedId) throw new Error('Deployed ID differs from deterministic ID');
    liveHash = readContractHash(expectedId);
    if (liveHash !== hash) throw new Error('Deployed WASM differs from the validated build');
    deployedNow = true;
    deployedAt = new Date().toISOString();

    const transactions = await getJson(
      `${horizonUrl}/accounts/${deployer}/transactions?order=desc&limit=20`,
    );
    const candidates = transactions._embedded.records.filter(
      (tx) => BigInt(tx.source_account_sequence) > beforeSequence && tx.successful,
    );
    for (const tx of candidates) {
      const operations = await getJson(`${horizonUrl}/transactions/${tx.hash}/operations`);
      if (operations._embedded.records.some((op) => op.function?.includes('CreateContract'))) {
        transactionHash = tx.hash;
        deploymentLedger = tx.ledger;
        break;
      }
    }
  }

  const config = invokeRead(expectedId, deployer, 'get_config');
  if (config.admin !== deployer || config.usdc !== usdcSac || config.protocol_version !== 1) {
    throw new Error('Live constructor config does not match the approved deployment');
  }

  const artifact = {
    network,
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    deployer,
    usdcIssuer,
    usdcAssetContractId: usdcSac,
    contractId: expectedId,
    protocolVersion: 1,
    wasmHash: hash,
    salt,
    deploymentTransactionHash: transactionHash,
    deploymentLedger,
    deployedAt,
  };
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`MilvanceCore ${deployedNow ? 'deployed' : 'verified'} on Testnet: ${expectedId}`);
  console.log(`USDC SAC: ${usdcSac}`);
  console.log(`Artifact: ${artifactPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
