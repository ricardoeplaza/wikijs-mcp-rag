import { z } from 'zod';
import { logger } from './logger.js';

const boolFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  // --- Wiki.js ---
  WIKIJS_BASE_URL: z.string().url().default('http://wikijs:3000'),
  WIKIJS_TOKEN: z.string().default(''),
  WIKIJS_INSECURE_TLS: boolFromEnv.default('true'),

  // --- Embeddings (external llama.cpp, OpenAI-compatible) ---
  EMBEDDINGS_BASE_URL: z.string().url(),
  EMBEDDINGS_API_KEY: z.string().default('no-key'),
  EMBEDDINGS_MODEL: z.string().min(1).default('Qwen3-Embedding-0.6B'),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1024),

  // --- MCP ---
  MCP_TOKEN: z.string().default(''),
  MCP_ALLOW_NOAUTH: boolFromEnv.default('false'),
  MCP_HOST: z.string().min(1).default('0.0.0.0'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8000),

  // --- RAG storage ---
  RAG_DB_PATH: z.string().min(1).default('/data/rag.db'),

  // --- Sync ---
  SYNC_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300_000),
  NIGHTLY_RESYNC_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  NIGHTLY_RESYNC_ENABLED: boolFromEnv.default('true'),

  // --- Logging ---
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- Chunking / retrieval ---
  CHUNK_TARGET_TOKENS: z.coerce.number().int().positive().default(800),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(150),
  RAG_DEFAULT_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
});

export type EnvSchema = typeof envSchema;

export interface Config {
  wikijsBaseUrl: string;
  wikijsToken: string;
  wikijsInsecureTls: boolean;
  embeddingsBaseUrl: string;
  embeddingsApiKey: string;
  embeddingsModel: string;
  embeddingsDim: number;
  mcpToken: string;
  mcpAllowNoAuth: boolean;
  mcpHost: string;
  mcpPort: number;
  ragDbPath: string;
  syncPollIntervalMs: number;
  nightlyResyncHour: number;
  nightlyResyncEnabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  chunkTargetTokens: number;
  chunkOverlapTokens: number;
  ragDefaultTopK: number;
}

function toConfig(data: z.infer<EnvSchema>): Config {
  return {
    wikijsBaseUrl: data.WIKIJS_BASE_URL,
    wikijsToken: data.WIKIJS_TOKEN,
    wikijsInsecureTls: data.WIKIJS_INSECURE_TLS,
    embeddingsBaseUrl: data.EMBEDDINGS_BASE_URL,
    embeddingsApiKey: data.EMBEDDINGS_API_KEY,
    embeddingsModel: data.EMBEDDINGS_MODEL,
    embeddingsDim: data.EMBEDDINGS_DIM,
    mcpToken: data.MCP_TOKEN,
    mcpAllowNoAuth: data.MCP_ALLOW_NOAUTH,
    mcpHost: data.MCP_HOST,
    mcpPort: data.MCP_PORT,
    ragDbPath: data.RAG_DB_PATH,
    syncPollIntervalMs: data.SYNC_POLL_INTERVAL_MS,
    nightlyResyncHour: data.NIGHTLY_RESYNC_HOUR,
    nightlyResyncEnabled: data.NIGHTLY_RESYNC_ENABLED,
    logLevel: data.LOG_LEVEL,
    chunkTargetTokens: data.CHUNK_TARGET_TOKENS,
    chunkOverlapTokens: data.CHUNK_OVERLAP_TOKENS,
    ragDefaultTopK: data.RAG_DEFAULT_TOP_K,
  };
}

/**
 * Loads and validates the environment configuration.
 *
 * D9 (MCP auth):
 * - MCP_TOKEN empty + MCP_ALLOW_NOAUTH=false -> throws (refuse to start).
 * - MCP_TOKEN empty + MCP_ALLOW_NOAUTH=true  -> dev mode with a loud warning.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const config = toConfig(parsed.data);

  if (config.mcpToken === '' && !config.mcpAllowNoAuth) {
    throw new Error(
      'MCP_TOKEN is empty and MCP_ALLOW_NOAUTH=false: refusing to start without authentication. ' +
        'Set MCP_TOKEN in the environment, or set MCP_ALLOW_NOAUTH=true for local development only.',
    );
  }
  if (config.mcpToken === '' && config.mcpAllowNoAuth) {
    logger.warn(
      '!!! MCP_TOKEN is empty and MCP_ALLOW_NOAUTH=true: running WITHOUT authentication. ' +
        'Do NOT expose this instance to untrusted networks. !!!',
    );
  }

  if (config.wikijsToken === '') {
    logger.warn(
      'WIKIJS_TOKEN is empty: the Wiki.js client will call the GraphQL API WITHOUT an ' +
        'Authorization header. This only works when the target Wiki.js instance has no ' +
        'API key / admin token configured.',
    );
  }

  return config;
}
