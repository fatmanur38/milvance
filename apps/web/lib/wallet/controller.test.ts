import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletController, type PublicSessionStore } from './controller';
import type { ChainOrder, ContractPort, PreparedOrder, TrustlinePort, WalletPort } from './ports';
import { testnetDeployment } from './config';

const buyer = 'GBUYER';
const order: ChainOrder = {
  id: '7',
  buyer,
  supplier: 'GSUPPLIER',
  attestor: 'GATTESTOR',
  resolver: 'GRESOLVER',
  asset: testnetDeployment.usdcAssetContractId,
  status: 'Created',
};

function harness() {
  let saved: string | null = null;
  const session: PublicSessionStore = {
    get: () => saved,
    set: (address) => {
      saved = address;
    },
    clear: () => {
      saved = null;
    },
  };
  const wallet: WalletPort = {
    connect: vi.fn(async () => buyer),
    restore: vi.fn(async () => buyer),
    disconnect: vi.fn(async () => undefined),
    networkPassphrase: vi.fn(async () => testnetDeployment.networkPassphrase),
    currentAddress: vi.fn(async () => buyer),
    signTransaction: vi.fn(async () => 'signed'),
  };
  const trustline: TrustlinePort = { check: vi.fn(async () => 'present' as const) };
  const prepared: PreparedOrder = {
    orderId: '7',
    sign: vi.fn(async () => undefined),
    send: vi.fn(async (onSubmitted, onConfirming) => {
      onSubmitted('abc123');
      onConfirming();
      return 'abc123';
    }),
  };
  const contract: ContractPort = {
    prepareCreateOrder: vi.fn(async () => prepared),
    readOrder: vi.fn(async () => order),
  };
  const controller = new WalletController(wallet, trustline, contract, session);
  return { controller, wallet, trustline, contract, prepared, session };
}

const input = { supplier: 'GSUPPLIER', attestor: 'GATTESTOR', resolver: 'GRESOLVER' };

describe('wallet authorization flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts disconnected, connects with a public address, restores and disconnects', async () => {
    const { controller, wallet, session } = harness();
    expect(controller.snapshot()).toEqual({ phase: 'disconnected' });
    await controller.connect();
    expect(controller.snapshot()).toMatchObject({ phase: 'connected', address: buyer });
    expect(session.get()).toBe(buyer);
    await controller.disconnect();
    expect(controller.snapshot()).toEqual({ phase: 'disconnected' });
    expect(session.get()).toBeNull();
    expect(wallet.disconnect).toHaveBeenCalledOnce();
    session.set(buyer);
    await controller.restore();
    expect(wallet.restore).toHaveBeenCalledOnce();
    expect(controller.snapshot().address).toBe(buyer);
  });

  it('blocks a wrong network before contract simulation and signing', async () => {
    const { controller, wallet, contract } = harness();
    vi.mocked(wallet.networkPassphrase).mockResolvedValue(
      'Public Global Stellar Network ; September 2015',
    );
    await controller.connect();
    expect(controller.snapshot().phase).toBe('wrong-network');
    await controller.createOrder(input);
    expect(contract.prepareCreateOrder).not.toHaveBeenCalled();
  });

  it('shows a missing USDC trustline without claiming it exists', async () => {
    const { controller, trustline } = harness();
    vi.mocked(trustline.check).mockResolvedValue('missing');
    await controller.connect();
    expect(controller.snapshot()).toMatchObject({
      phase: 'trustline-required',
      trustline: 'missing',
    });
  });

  it('shows a present USDC trustline', async () => {
    const { controller } = harness();
    await controller.connect();
    expect(controller.snapshot()).toMatchObject({ phase: 'connected', trustline: 'present' });
  });

  it('keeps the wallet connected when Horizon cannot check the trustline', async () => {
    const { controller, trustline } = harness();
    vi.mocked(trustline.check).mockRejectedValue(new Error('Horizon unavailable'));
    await controller.connect();
    expect(controller.snapshot()).toMatchObject({
      phase: 'connected',
      address: buyer,
      detail: 'Horizon unavailable',
    });
    expect(controller.snapshot().trustline).toBeUndefined();
  });

  it('never submits after simulation failure', async () => {
    const { controller, contract, prepared } = harness();
    await controller.connect();
    vi.mocked(contract.prepareCreateOrder).mockRejectedValue(new Error('simulation rejected'));
    await controller.createOrder(input);
    expect(controller.snapshot()).toMatchObject({
      phase: 'simulation-failed',
      detail: 'simulation rejected',
    });
    expect(prepared.sign).not.toHaveBeenCalled();
    expect(prepared.send).not.toHaveBeenCalled();
  });

  it('does not submit or report success after wallet signature rejection', async () => {
    const { controller, prepared, contract } = harness();
    await controller.connect();
    vi.mocked(prepared.sign).mockRejectedValue(new Error('User declined'));
    await controller.createOrder(input);
    expect(controller.snapshot()).toMatchObject({
      phase: 'failed',
      detail: 'User declined',
    });
    expect(prepared.send).not.toHaveBeenCalled();
    expect(contract.readOrder).not.toHaveBeenCalled();
  });

  it('shows submission failure without a confirmed order', async () => {
    const { controller, prepared, contract } = harness();
    await controller.connect();
    vi.mocked(prepared.send).mockRejectedValue(new Error('RPC rejected'));
    await controller.createOrder(input);
    expect(controller.snapshot()).toMatchObject({ phase: 'failed', detail: 'RPC rejected' });
    expect(contract.readOrder).not.toHaveBeenCalled();
  });

  it('tracks submission and confirmation, then re-reads authoritative order state', async () => {
    const { controller, prepared, contract } = harness();
    const phases: string[] = [];
    controller.subscribe(() => phases.push(controller.snapshot().phase));
    await controller.connect();
    await controller.createOrder(input);
    expect(prepared.sign).toHaveBeenCalledOnce();
    expect(prepared.send).toHaveBeenCalledOnce();
    expect(contract.readOrder).toHaveBeenCalledWith(buyer, '7');
    expect(phases).toContain('preparing-transaction');
    expect(phases).toContain('awaiting-wallet-signature');
    expect(phases).toContain('submitted');
    expect(phases).toContain('confirming');
    expect(controller.snapshot()).toEqual({
      phase: 'confirmed',
      address: buyer,
      transactionHash: 'abc123',
      order,
    });
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      address: buyer,
      transactionHash: 'abc123',
      order,
    });
  });

  it('rejects a changed wallet account before building a transaction', async () => {
    const { controller, wallet, contract } = harness();
    await controller.connect();
    vi.mocked(wallet.currentAddress).mockResolvedValue('GOTHER');
    await controller.createOrder(input);
    expect(controller.snapshot().phase).toBe('failed');
    expect(contract.prepareCreateOrder).not.toHaveBeenCalled();
  });
});

describe('signing guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to sign while disconnected', async () => {
    const { controller, wallet } = harness();
    await expect(controller.signRaw('xdr')).rejects.toThrow(/Connect your wallet/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses to sign on the wrong network, and says so', async () => {
    const { controller, wallet } = harness();
    vi.mocked(wallet.networkPassphrase).mockResolvedValue(
      'Public Global Stellar Network ; September 2015',
    );
    await controller.connect();
    expect(controller.state.phase).toBe('wrong-network');
    await expect(controller.signRaw('xdr')).rejects.toThrow(/Testnet/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('still signs actions that move no USDC when the trustline is missing', async () => {
    const { controller, wallet, trustline } = harness();
    vi.mocked(trustline.check).mockResolvedValue('missing');
    await controller.connect();
    expect(controller.state.phase).toBe('trustline-required');
    await expect(controller.signRaw('xdr')).resolves.toBe('signed');
    expect(wallet.signTransaction).toHaveBeenCalledWith('xdr', buyer);
  });

  it('keeps signing available after an earlier transaction confirmed', async () => {
    const { controller } = harness();
    await controller.connect();
    await controller.createOrder(input);
    expect(controller.state.phase).toBe('confirmed');
    await expect(controller.signRaw('next')).resolves.toBe('signed');
  });
});

/**
 * One person plays several parties in a trade: buyer, then supplier, then
 * funder. They switch account inside Freighter, which cannot tell the page.
 * If the workspace keeps the previous address, every action it builds names
 * the wrong party and is refused at signing — so the account the user sees
 * must follow the account Freighter is actually on.
 */
describe('Freighter account switching', () => {
  beforeEach(() => vi.clearAllMocks());

  const supplier = 'GSUPPLIER';

  it('follows an account switch without a reconnect', async () => {
    const { controller, wallet, session } = harness();
    await controller.connect();
    expect(controller.state.address).toBe(buyer);

    vi.mocked(wallet.currentAddress).mockResolvedValue(supplier);
    await controller.sync();

    expect(controller.state.address).toBe(supplier);
    expect(controller.state.phase).toBe('connected');
    expect(session.get()).toBe(supplier);
    // Only the explicit connect above: the switch needed no reconnect.
    expect(wallet.connect).toHaveBeenCalledTimes(1);
  });

  it('re-checks the USDC trustline for the account switched to', async () => {
    const { controller, wallet, trustline } = harness();
    await controller.connect();

    vi.mocked(wallet.currentAddress).mockResolvedValue(supplier);
    vi.mocked(trustline.check).mockResolvedValue('missing');
    await controller.sync();

    expect(trustline.check).toHaveBeenCalledWith(supplier);
    expect(controller.state.phase).toBe('trustline-required');
    expect(controller.state.trustline).toBe('missing');
  });

  it('signs with the account switched to, never the previous one', async () => {
    const { controller, wallet } = harness();
    await controller.connect();
    vi.mocked(wallet.currentAddress).mockResolvedValue(supplier);
    await controller.sync();

    await expect(controller.signRaw('xdr')).resolves.toBe('signed');
    expect(wallet.signTransaction).toHaveBeenCalledWith('xdr', supplier);
    expect(wallet.signTransaction).not.toHaveBeenCalledWith('xdr', buyer);
  });

  it('does not carry one account’s transaction over to the next', async () => {
    const { controller, wallet } = harness();
    await controller.connect();
    await controller.createOrder(input);
    expect(controller.state.transactionHash).toBe('abc123');

    vi.mocked(wallet.currentAddress).mockResolvedValue(supplier);
    await controller.sync();

    expect(controller.state.address).toBe(supplier);
    expect(controller.state.transactionHash).toBeUndefined();
    expect(controller.state.order).toBeUndefined();
  });

  it('leaves the connected account alone when the wallet cannot be read', async () => {
    const { controller, wallet } = harness();
    await controller.connect();

    vi.mocked(wallet.currentAddress).mockRejectedValue(new Error('extension locked'));
    await controller.sync();

    expect(controller.state.address).toBe(buyer);
    expect(controller.state.phase).toBe('connected');
    expect(controller.state.message).toBeUndefined();
  });

  it('reports a network switch, and recovers when Testnet comes back', async () => {
    const { controller, wallet } = harness();
    await controller.connect();

    vi.mocked(wallet.networkPassphrase).mockResolvedValue(
      'Public Global Stellar Network ; September 2015',
    );
    await controller.sync();
    expect(controller.state.phase).toBe('wrong-network');

    vi.mocked(wallet.networkPassphrase).mockResolvedValue(testnetDeployment.networkPassphrase);
    await controller.sync();
    expect(controller.state.phase).toBe('connected');
    expect(controller.state.address).toBe(buyer);
  });

  it('does not ask Horizon again while the account is unchanged', async () => {
    const { controller, trustline } = harness();
    await controller.connect();
    vi.mocked(trustline.check).mockClear();

    await controller.sync();
    await controller.sync();

    expect(trustline.check).not.toHaveBeenCalled();
  });

  it('stays quiet while no wallet is connected', async () => {
    const { controller, wallet } = harness();
    await controller.sync();
    expect(wallet.currentAddress).not.toHaveBeenCalled();
    expect(controller.state.phase).toBe('disconnected');
  });
});
