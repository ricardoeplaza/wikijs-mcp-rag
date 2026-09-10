import pino from 'pino';

const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type PinoLevel = (typeof PINO_LEVELS)[number];

export function resolveLogLevel(raw: string | undefined): PinoLevel {
  if (!raw) return 'info';
  const normalized = raw.toLowerCase();
  return (PINO_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as PinoLevel)
    : 'info';
}

export const logger = pino({
  level: resolveLogLevel(process.env.LOG_LEVEL),
});
