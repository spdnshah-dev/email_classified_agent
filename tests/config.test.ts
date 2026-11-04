import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, loadConfig } from '../lib/config.js';
import { VALID_ENV } from './helpers.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config.openRouterModel).toBe(DEFAULTS.OPENROUTER_MODEL);
    expect(config.openRouterFallbackModels).toEqual([
      'xingchen-agi/xing4.0-29b-a4b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ]);
    expect(config.labelImportant).toBe('Important Emails');
    expect(config.maxEmailsPerRun).toBe(15);
    expect(config.lookbackDays).toBe(7);
    expect(config.bodyMaxChars).toBe(4000);
    expect(config.gmailAddress).toBeUndefined();
  });

  it('lists every missing variable in one error', () => {
    try {
      loadConfig({});
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems).toEqual(
        expect.arrayContaining([
          'GOOGLE_CLIENT_ID is required but not set',
          'GOOGLE_CLIENT_SECRET is required but not set',
          'GOOGLE_REFRESH_TOKEN is required but not set',
          'PUBSUB_TOPIC is required but not set',
          'WEBHOOK_SECRET is required but not set',
          'CRON_SECRET is required but not set',
          'OPENROUTER_API_KEY is required but not set',
        ]),
      );
    }
  });

  it('rejects bad numbers, bad topic names and duplicate labels', () => {
    expect(() =>
      loadConfig({
        ...VALID_ENV,
        PUBSUB_TOPIC: 'gmail-push',
        MAX_EMAILS_PER_RUN: '0',
        LOOKBACK_DAYS: 'seven',
        LABEL_JUNK: 'important emails',
      }),
    ).toThrow(
      /PUBSUB_TOPIC must look like[\s\S]*distinct[\s\S]*MAX_EMAILS_PER_RUN[\s\S]*LOOKBACK_DAYS/,
    );
  });

  it('parses fallback models, trims, and drops the primary from the fallback list', () => {
    const config = loadConfig({
      ...VALID_ENV,
      OPENROUTER_MODEL: 'a/b',
      OPENROUTER_FALLBACK_MODELS: ' a/b , c/d ,, e/f ',
      GMAIL_ADDRESS: 'Me@Gmail.com',
      MAX_EMAILS_PER_RUN: '5',
    });
    expect(config.openRouterFallbackModels).toEqual(['c/d', 'e/f']);
    expect(config.gmailAddress).toBe('me@gmail.com');
    expect(config.maxEmailsPerRun).toBe(5);
  });

  it('treats empty strings as unset', () => {
    expect(() => loadConfig({ ...VALID_ENV, CRON_SECRET: '   ' })).toThrow(
      /CRON_SECRET is required/,
    );
  });
});
