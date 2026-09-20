import { testnetDeployment } from './config';
import type {
  ChainOrder,
  ContractPort,
  CreateOrderInput,
  TrustlinePort,
  TrustlineStatus,
  WalletPort,
} from './ports';

export type WalletPhase =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'wrong-network'
  | 'trustline-required'
  | 'preparing-transaction'
  | 'simulation-failed'
  | 'awaiting-wallet-signature'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed';

export interface WalletState {
  phase: WalletPhase;
  address?: string;
  trustline?: TrustlineStatus;
  transactionHash?: string;
  order?: ChainOrder;
  message?: string;
  detail?: string;
}

export interface PublicSessionStore {
  get(): string | null;
  set(address: string): void;
  clear(): void;
}

export class BrowserSessionStore implements PublicSessionStore {
  private readonly key = 'milvance:wallet-address';
  get(): string | null {
    return window.localStorage.getItem(this.key);
  }
  set(address: string): void {
    window.localStorage.setItem(this.key, address);
  }
  clear(): void {
    window.localStorage.removeItem(this.key);
  }
}

const detail = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return 'The wallet or network request failed.';
};

/**
 * Whether the wallet is in a state where the user can be asked to sign.
 *
 * True once an address is known on the right network, including after a
 * previous transaction confirmed or failed. False while disconnected,
 * connecting, or on the wrong network.
 */
export function canSign(state: WalletState): boolean {
  return (
    state.address !== undefined &&
    state.phase !== 'disconnected' &&
    state.phase !== 'connecting' &&
    state.phase !== 'wrong-network'
  );
}

export class WalletController {
  state: WalletState = { phase: 'disconnected' };
  private listeners = new Set<() => void>();
  private busy = false;
  private syncing = false;

  constructor(
    private readonly wallet: WalletPort,
    private readonly trustline: TrustlinePort,
    private readonly contract: ContractPort,
    private readonly session: PublicSessionStore,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): WalletState => this.state;

  private update(patch: WalletState): void {
    this.state = patch;
    this.listeners.forEach((listener) => listener());
  }

  private async inspect(address: string): Promise<void> {
    if ((await this.wallet.networkPassphrase()) !== testnetDeployment.networkPassphrase) {
      this.update({
        phase: 'wrong-network',
        address,
        message: 'Switch Freighter to Stellar Testnet.',
      });
      return;
    }
    let trustline: TrustlineStatus;
    try {
      trustline = await this.trustline.check(address);
    } catch (error) {
      this.update({
        phase: 'connected',
        address,
        message: 'Could not check the USDC trustline. Retry with Refresh wallet status.',
        detail: detail(error),
      });
      return;
    }
    const previous =
      this.state.address === address
        ? {
            ...(this.state.transactionHash ? { transactionHash: this.state.transactionHash } : {}),
            ...(this.state.order ? { order: this.state.order } : {}),
          }
        : {};
    this.update({
      phase: trustline === 'present' ? 'connected' : 'trustline-required',
      address,
      trustline,
      ...previous,
    });
  }

  async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.update({ phase: 'connecting' });
    try {
      const address = await this.wallet.connect();
      this.session.set(address);
      await this.inspect(address);
    } catch (error) {
      this.update({
        phase: 'disconnected',
        message: 'Could not connect Freighter.',
        detail: detail(error),
      });
    } finally {
      this.busy = false;
    }
  }

  async restore(): Promise<void> {
    if (!this.session.get() || this.busy) return;
    this.busy = true;
    this.update({ phase: 'connecting' });
    try {
      const address = await this.wallet.restore();
      this.session.set(address);
      await this.inspect(address);
    } catch {
      this.session.clear();
      this.update({ phase: 'disconnected' });
    } finally {
      this.busy = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.busy) return;
    await this.wallet.disconnect();
    this.session.clear();
    this.update({ phase: 'disconnected' });
  }

  /**
   * Signs a transaction XDR with the connected wallet.
   *
   * Used for everything the user authorizes outside the create-order flow:
   * MilvanceCore actions built by the generated bindings, the Anchor's SEP-10
   * sign-in challenge, and the USDC payment that settles a withdrawal.
   *
   * The guard here is deliberately about identity, not about USDC: a missing
   * trustline must not stop a supplier accepting an order or an attestor
   * verifying a milestone, neither of which moves USDC. The authoritative
   * checks — right network, same account — run again inside the wallet port at
   * the moment of signing, so a stale phase can never produce a wrong signature.
   *
   * Returns the signed XDR. It never sees a secret key.
   */
  async signRaw(xdr: string): Promise<string> {
    const address = this.state.address;
    if (!canSign(this.state) || address === undefined) {
      throw new Error(
        this.state.phase === 'wrong-network'
          ? 'Switch Freighter to Stellar Testnet before signing.'
          : 'Connect your wallet before signing.',
      );
    }
    return this.wallet.signTransaction(xdr, address);
  }

  /**
   * Background check that the connected account and network still match.
   *
   * Freighter can switch accounts at any moment and cannot tell the page. One
   * person acting as buyer, then supplier, then funder does it constantly, so
   * an address read once at connect time goes stale silently — and every
   * action built from it names the wrong party. Polling this keeps the
   * workspace on the account the user is actually using, without asking them
   * to reconnect.
   *
   * Unlike refresh(), a transient failure is ignored: this runs unattended, so
   * a locked extension or a slow Horizon must not flap the UI into an error.
   * The authoritative account and network checks still run inside the wallet
   * port at the moment of signing.
   */
  async sync(): Promise<void> {
    if (!this.state.address || this.busy || this.syncing) return;
    this.syncing = true;
    try {
      const address = await this.wallet.currentAddress();
      if (address !== this.state.address) {
        this.session.set(address);
        await this.inspect(address);
        return;
      }
      const onTestnet =
        (await this.wallet.networkPassphrase()) === testnetDeployment.networkPassphrase;
      if (!onTestnet && this.state.phase !== 'wrong-network') {
        this.update({
          phase: 'wrong-network',
          address,
          message: 'Switch Freighter to Stellar Testnet.',
        });
      } else if (onTestnet && this.state.phase === 'wrong-network') {
        await this.inspect(address);
      }
    } catch {
      // Extension locked, popup open, or Horizon unreachable. Keep the last
      // known state; the next tick tries again.
    } finally {
      this.syncing = false;
    }
  }

  async refresh(): Promise<void> {
    if (!this.state.address || this.busy) return;
    try {
      const address = await this.wallet.currentAddress();
      if (address !== this.state.address) this.session.set(address);
      await this.inspect(address);
    } catch (error) {
      this.update({
        ...this.state,
        phase: 'failed',
        message: 'Could not refresh wallet status.',
        detail: detail(error),
      });
    }
  }

  async createOrder(input: CreateOrderInput): Promise<void> {
    if (!this.state.address || this.busy) return;
    const buyer = this.state.address;
    this.busy = true;
    // Query wallet state just before building the transaction. Never trust the cached UI state.
    try {
      if (buyer !== (await this.wallet.currentAddress())) {
        this.update({
          phase: 'failed',
          address: buyer,
          message: 'Wallet account changed. Refresh.',
        });
        return;
      }
      if ((await this.wallet.networkPassphrase()) !== testnetDeployment.networkPassphrase) {
        this.update({
          phase: 'wrong-network',
          address: buyer,
          message: 'Switch Freighter to Stellar Testnet.',
        });
        return;
      }
      this.update({ phase: 'preparing-transaction', address: buyer });
      let prepared: Awaited<ReturnType<ContractPort['prepareCreateOrder']>>;
      try {
        prepared = await this.contract.prepareCreateOrder(buyer, input);
      } catch (error) {
        this.update({
          phase: 'simulation-failed',
          address: buyer,
          message: 'Contract simulation failed. Check account funding and party addresses.',
          detail: detail(error),
        });
        return;
      }
      this.update({ phase: 'awaiting-wallet-signature', address: buyer });
      try {
        await prepared.sign();
      } catch (error) {
        this.update({
          phase: 'failed',
          address: buyer,
          message: 'Wallet signature was rejected or failed. No transaction was submitted.',
          detail: detail(error),
        });
        return;
      }
      const hash = await prepared.send(
        (transactionHash) => this.update({ phase: 'submitted', address: buyer, transactionHash }),
        () => this.update({ ...this.state, phase: 'confirming' }),
      );
      this.update({ phase: 'confirming', address: buyer, transactionHash: hash });
      const order = await this.contract.readOrder(buyer, prepared.orderId);
      if (order.buyer !== buyer || order.id !== prepared.orderId) {
        throw new Error('Confirmed order does not match the connected buyer.');
      }
      this.update({ phase: 'confirmed', address: buyer, transactionHash: hash, order });
    } catch (error) {
      this.update({
        ...this.state,
        phase: 'failed',
        message: 'Transaction submission, confirmation, or contract refresh failed.',
        detail: detail(error),
      });
    } finally {
      this.busy = false;
    }
  }
}
