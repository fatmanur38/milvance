import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Asset, Networks } from '@stellar/stellar-sdk';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const artifactPath = resolve(root, 'deployments/testnet.json');
export const wasmPath = resolve(root, 'target/wasm32v1-none/release/milvance_core.wasm');
export const network = 'testnet';
export const networkPassphrase = 'Test SDF Network ; September 2015';
export const rpcUrl = 'https://soroban-testnet.stellar.org';
export const horizonUrl = 'https://horizon-testnet.stellar.org';
export const usdcIssuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const usdcAsset = `USDC:${usdcIssuer}`;

export function stellar(args) {
  return execFileSync('stellar', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function wasmHash() {
  return sha256(readFileSync(wasmPath));
}

export async function getJson(url) {
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response.json();
}

export function verifyNetwork() {
  if (Networks.TESTNET !== networkPassphrase) throw new Error('SDK Testnet passphrase mismatch');
  const result = spawnSync('stellar', ['network', 'info', '--network', network], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('Cannot connect to Stellar Testnet RPC');
  const info = `${result.stdout}${result.stderr}`;
  if (!info.includes(`Passphrase: ${networkPassphrase}`)) {
    throw new Error('The local Stellar CLI testnet alias has the wrong passphrase');
  }
}

export function verifyUsdcSac(publicAddress) {
  const cliId = stellar(['contract', 'id', 'asset', '--asset', usdcAsset, '--network', network]);
  const sdkId = new Asset('USDC', usdcIssuer).contractId(Networks.TESTNET);
  if (cliId !== sdkId) throw new Error('CLI and SDK disagree on the USDC SAC ID');

  const invoke = (method) =>
    JSON.parse(
      stellar([
        'contract',
        'invoke',
        '--id',
        cliId,
        '--network',
        network,
        '--source-account',
        publicAddress,
        '--send=no',
        '--',
        method,
      ]),
    );
  if (invoke('symbol') !== 'USDC' || invoke('name') !== usdcAsset) {
    throw new Error('Live SAC metadata does not match the approved USDC issuer');
  }
  return cliId;
}

export function readArtifact() {
  try {
    return JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function readContractHash(contractId) {
  return stellar(['contract', 'info', 'hash', '--contract-id', contractId, '--network', network]);
}

export function invokeRead(contractId, publicAddress, method) {
  return JSON.parse(
    stellar([
      'contract',
      'invoke',
      '--id',
      contractId,
      '--network',
      network,
      '--source-account',
      publicAddress,
      '--send=no',
      '--',
      method,
    ]),
  );
}
