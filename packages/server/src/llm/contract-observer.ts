import { contract as observe, type ContractSpec } from './contract-runtime.js';

// The injectable metadata includes fields beyond the generated runtime's observation options.
export function contract<Args extends unknown[], Result>(
  target: (...args: Args) => Result,
  spec: ContractSpec<Args, Result> & { mode: 'observe'; sample: 1; rule: 'contract-wrap' },
): (...args: Args) => Result {
  return observe(target, spec);
}
