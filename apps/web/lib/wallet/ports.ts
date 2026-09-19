export interface WalletPort {
  connect(): Promise<string>;
  restore(): Promise<string>;
  disconnect(): Promise<void>;
  networkPassphrase(): Promise<string>;
  currentAddress(): Promise<string>;
  signTransaction(xdr: string, address: string): Promise<string>;
}

export type TrustlineStatus = 'present' | 'missing' | 'unfunded';

export interface TrustlinePort {
  check(address: string): Promise<TrustlineStatus>;
}

export interface CreateOrderInput {
  supplier: string;
  attestor: string;
  resolver: string;
}

export interface ChainOrder {
  id: string;
  buyer: string;
  supplier: string;
  attestor: string;
  resolver: string;
  asset: string;
  status: string;
}

export interface PreparedOrder {
  orderId: string;
  sign(): Promise<void>;
  send(onSubmitted: (hash: string) => void, onConfirming: () => void): Promise<string>;
}

export interface ContractPort {
  prepareCreateOrder(buyer: string, input: CreateOrderInput): Promise<PreparedOrder>;
  readOrder(buyer: string, orderId: string): Promise<ChainOrder>;
}
