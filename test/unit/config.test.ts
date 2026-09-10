import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { logger } from '../../src/logger.js';

const ENV_KEYS = [
  'WIKIJS_BASE_URL',
  'WIKIJS_TOKEN',
  'WIKIJS_INSECURE_TLS',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_DIM',
  'MCP_TOKEN',
  'MCP_ALLOW_NOAUTH',
  'MCP_HOST',
  'MCP_PORT',
  'RAG_DB_PATH',
  'SYNC_POLL_INTERVAL_MS',
  'NIGHTLY_RESYNC_HOUR',
  'NIGHTLY_RESYNC_ENABLED',
  'LOG_LEVEL',
  'CHUNK_TARGET_TOKENS',
  'CHUNK_OVERLAP_TOKENS',
  'RAG_DEFAULT_TOP_K',
] as const;

const VALID_ENV: Record<string, string> = {
  WIKIJS_TOKEN: 'test-wiki-token',
  EMBEDDINGS_BASE_URL: 'http://localhost:8071/v1',
  MCP_TOKEN: 'test-mcp-token',
};

function setEnv(overrides: Record<string, string> = {}): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...VALID_ENV, ...overrides })) {
    process.env[key] = value;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('loadConfig', () => {
  it('parses a fully valid environment and maps to camelCase', () => {
    setEnv({
      WIKIJS_BASE_URL: 'https://wiki.example.com',
      WIKIJS_INSECURE_TLS: 'false',
      EMBEDDINGS_API_KEY: 'k',
      EMBEDDINGS_MODEL: 'EmbeddingGemma-300M',
      EMBEDDINGS_DIM: '768',
      MCP_ALLOW_NOAUTH: 'false',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '9000',
      RAG_DB_PATH: '/tmp/rag.db',
      SYNC_POLL_INTERVAL_MS: '0',
      NIGHTLY_RESYNC_HOUR: '22',
      NIGHTLY_RESYNC_ENABLED: 'false',
      LOG_LEVEL: 'debug',
      CHUNK_TARGET_TOKENS: '500',
      CHUNK_OVERLAP_TOKENS: '100',
      RAG_DEFAULT_TOP_K: '10',
    });

    const config = loadConfig();

    expect(config).toEqual({
      wikijsBaseUrl: 'https://wiki.example.com',
      wikijsToken: 'test-wiki-token',
      wikijsInsecureTls: false,
      embeddingsBaseUrl: 'http://localhost:8071/v1',
      embeddingsApiKey: 'k',
      embeddingsModel: 'EmbeddingGemma-300M',
      embeddingsDim: 768,
      mcpToken: 'test-mcp-token',
      mcpAllowNoAuth: false,
      mcpHost: '127.0.0.1',
      mcpPort: 9000,
      ragDbPath: '/tmp/rag.db',
      syncPollIntervalMs: 0,
      nightlyResyncHour: 22,
      nightlyResyncEnabled: false,
      logLevel: 'debug',
      chunkTargetTokens: 500,
      chunkOverlapTokens: 100,
      ragDefaultTopK: 10,
    });
  });

  it('applies documented defaults when optional variables are absent', () => {
    setEnv();

    const config = loadConfig();

    expect(config.wikijsBaseUrl).toBe('http://wikijs:3000');
    expect(config.wikijsInsecureTls).toBe(true);
    expect(config.embeddingsApiKey).toBe('no-key');
    expect(config.embeddingsModel).toBe('Qwen3-Embedding-0.6B');
    expect(config.embeddingsDim).toBe(1024);
    expect(config.mcpAllowNoAuth).toBe(false);
    expect(config.mcpHost).toBe('0.0.0.0');
    expect(config.mcpPort).toBe(8000);
    expect(config.ragDbPath).toBe('/data/rag.db');
    expect(config.syncPollIntervalMs).toBe(300_000);
    expect(config.nightlyResyncHour).toBe(3);
    expect(config.nightlyResyncEnabled).toBe(true);
    expect(config.logLevel).toBe('info');
    expect(config.chunkTargetTokens).toBe(800);
    expect(config.chunkOverlapTokens).toBe(150);
    expect(config.ragDefaultTopK).toBe(5);
  });

  it('throws when MCP_TOKEN is empty and MCP_ALLOW_NOAUTH is false (default)', () => {
    setEnv({ MCP_TOKEN: '' });

    expect(() => loadConfig()).toThrowError(/MCP_TOKEN/);
  });

  it('throws when MCP_TOKEN is empty, MCP_ALLOW_NOAUTH absent and explicitly false', () => {
    setEnv({ MCP_TOKEN: '', MCP_ALLOW_NOAUTH: 'false' });

    expect(() => loadConfig()).toThrowError(/refusing to start/i);
  });

  it('starts in dev mode (no throw) when MCP_TOKEN is empty and MCP_ALLOW_NOAUTH=true', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    setEnv({ MCP_TOKEN: '', MCP_ALLOW_NOAUTH: 'true' });

    const config = loadConfig();

    expect(config.mcpToken).toBe('');
    expect(config.mcpAllowNoAuth).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WITHOUT authentication'));
  });

  it.each(['abc', '0', '-1', '1024.5'])('rejects invalid EMBEDDINGS_DIM: %s', (dim) => {
    setEnv({ EMBEDDINGS_DIM: dim });

    expect(() => loadConfig()).toThrowError(/EMBEDDINGS_DIM/);
  });

  it('rejects missing required variables', () => {
    setEnv();
    delete process.env.WIKIJS_TOKEN;
    expect(() => loadConfig()).toThrowError(/WIKIJS_TOKEN/);

    setEnv();
    delete process.env.EMBEDDINGS_BASE_URL;
    expect(() => loadConfig()).toThrowError(/EMBEDDINGS_BASE_URL/);
  });

  it('rejects invalid LOG_LEVEL and MCP_PORT', () => {
    setEnv({ LOG_LEVEL: 'verbose' });
    expect(() => loadConfig()).toThrowError(/LOG_LEVEL/);

    setEnv({ MCP_PORT: '70000' });
    expect(() => loadConfig()).toThrowError(/MCP_PORT/);
  });
});
