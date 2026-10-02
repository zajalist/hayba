import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './llm-client.js';
import { getProvider, listProviders, registerCustomProvider } from './providers.js';

afterEach(() => vi.unstubAllEnvs());

describe('DeepSeek provider preset', () => {
  it('appears immediately after OpenAI with the current OpenAI-compatible endpoint and model', () => {
    const ids = listProviders().map((provider) => provider.id);
    expect(ids.indexOf('deepseek')).toBe(ids.indexOf('openai') + 1);
    expect(getProvider('deepseek')).toMatchObject({
      label: 'DeepSeek', baseURLDefault: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash', needsKey: true, protocol: 'openai',
    });
  });

  it('resolves an explicit key or the DeepSeek environment key without changing custom providers', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-env-key');
    expect(resolveConfig({ provider: 'deepseek' })).toMatchObject({
      provider: 'deepseek', baseURL: 'https://api.deepseek.com',
      model: 'deepseek-flash', apiKey: 'synthetic-env-key', protocol: 'openai',
    });
    expect(resolveConfig({ provider: 'deepseek', apiKey: 'synthetic-explicit-key' }).apiKey).toBe('synthetic-explicit-key');
    const custom = registerCustomProvider('Local Fixture', 'http://127.0.0.1:9988/v1', undefined, 'fixture-model');
    expect(custom).toMatchObject({ id: 'local-fixture', needsKey: false, protocol: 'openai', defaultModel: 'fixture-model' });
    expect(resolveConfig({ provider: custom.id }).baseURL).toBe('http://127.0.0.1:9988/v1');
  });
});
