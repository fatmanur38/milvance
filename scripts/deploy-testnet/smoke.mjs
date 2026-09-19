import console from 'node:console';

import {
  invokeRead,
  network,
  networkPassphrase,
  readArtifact,
  readContractHash,
  usdcIssuer,
  verifyNetwork,
  verifyUsdcSac,
} from './common.mjs';

const artifact = readArtifact();
if (!artifact) throw new Error('Testnet deployment artifact is missing');
verifyNetwork();
if (
  artifact.network !== network ||
  artifact.networkPassphrase !== networkPassphrase ||
  artifact.usdcIssuer !== usdcIssuer
) {
  throw new Error('Deployment artifact has unexpected network or issuer');
}
const assetId = verifyUsdcSac(artifact.deployer);
if (assetId !== artifact.usdcAssetContractId)
  throw new Error('Artifact SAC differs from live USDC');
if (readContractHash(artifact.contractId) !== artifact.wasmHash) {
  throw new Error('Live contract WASM differs from deployment artifact');
}
const version = invokeRead(artifact.contractId, artifact.deployer, 'protocol_version');
const config = invokeRead(artifact.contractId, artifact.deployer, 'get_config');
const orderCount = invokeRead(artifact.contractId, artifact.deployer, 'order_count');
if (
  version !== 1 ||
  config.protocol_version !== 1 ||
  config.admin !== artifact.deployer ||
  config.usdc !== assetId ||
  !Number.isInteger(orderCount) ||
  orderCount < 0
) {
  throw new Error('Live contract smoke read returned unexpected state');
}
console.log(
  JSON.stringify(
    {
      network,
      contractId: artifact.contractId,
      protocolVersion: version,
      usdcAssetContractId: assetId,
      orderCount,
      result: 'PASS',
    },
    null,
    2,
  ),
);
