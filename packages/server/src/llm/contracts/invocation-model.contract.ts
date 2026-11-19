import { resolveModel } from '@ludiars/one-shot';
import type { CliProvider } from '../cli-llm-client.js';

export default {
  post: (result: string, requested: string | undefined, fallback: string, provider: CliProvider): true | string => {
    const selected = requested ?? fallback;
    return result === resolveModel(selected, provider)
      || 'CLI model must match Lapilli resolution of the invocation override or client default';
  },
};
