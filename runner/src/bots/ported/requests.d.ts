export const NAME_MAX: number;
export type RequestIdentity = { key: string; print: string; unsent?: boolean };
export type ReceiptRecord<T> = {
  fingerprint: string;
  at: number;
  run: string;
  outcome: 'pending' | 'delivered' | 'uncertain';
  receipt?: T;
};
export type Verdict<T> =
  | { status: 'replay' | 'sent'; receipt: T }
  | { status: 'expired' | 'conflict' | 'uncertain' | 'readonly' };

type Host<T> = {
  state: { requests?: Record<string, ReceiptRecord<T>> };
  own(records: Record<string, ReceiptRecord<T>>, key: string): ReceiptRecord<T> | undefined;
  readOnly(): string | undefined;
  save(options?: { required: boolean }): Promise<void>;
  warn(): void;
};
type RequestRuntime<T> = {
  requestIdentity(input: { caller: string; context: string; name: string; payload: unknown }): RequestIdentity;
  knownRequest(request: RequestIdentity): Promise<Verdict<T> | undefined>;
  admitRequest(request: RequestIdentity, work: () => Promise<T>): Promise<Verdict<T>>;
};

export function install<T>(host: Host<T>): asserts host is Host<T> & RequestRuntime<T>;
