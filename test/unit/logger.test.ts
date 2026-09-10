import { describe, expect, it } from 'vitest';
import { resolveLogLevel } from '../../src/logger.js';

describe('resolveLogLevel', () => {
  it('defaults to info when LOG_LEVEL is unset', () => {
    expect(resolveLogLevel(undefined)).toBe('info');
  });

  it('accepts valid pino levels case-insensitively', () => {
    expect(resolveLogLevel('debug')).toBe('debug');
    expect(resolveLogLevel('INFO')).toBe('info');
    expect(resolveLogLevel('Warn')).toBe('warn');
    expect(resolveLogLevel('ERROR')).toBe('error');
  });

  it('falls back to info on invalid or empty values', () => {
    expect(resolveLogLevel('verbose')).toBe('info');
    expect(resolveLogLevel('')).toBe('info');
  });
});
