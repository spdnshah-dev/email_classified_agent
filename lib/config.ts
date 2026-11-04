/**
 * Environment variable loading and validation.
 * Fails fast with a message that names every missing or invalid variable.
 */

export interface Config {
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  pubsubTopic: string;
  gmailAddress: string | undefined;
  webhookSecret: string;
  cronSecret: string;
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterFallbackModels: string[];
  labelImportant: string;
  labelNeutral: string;
  labelJunk: string;
  maxEmailsPerRun: number;
  lookbackDays: number;
  bodyMaxChars: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

export const DEFAULTS = {
  OPENROUTER_MODEL: 'nvidia/nemotron-3.5-lightning:free',
  OPENROUTER_FALLBACK_MODELS:
    'xingchen-agi/xing4.0-29b-a4b:free,nvidia/nemotron-3-ultra-550b-a55b:free',
  LABEL_IMPORTANT: 'Important Emails',
  LABEL_NEUTRAL: 'Neutral Emails',
  LABEL_JUNK: 'Junk Emails',
  MAX_EMAILS_PER_RUN: 15,
  LOOKBACK_DAYS: 7,
  BODY_MAX_CHARS: 4000,
} as const;

type Env = Record<string, string | undefined>;

const PUBSUB_TOPIC_RE = /^projects\/[^/]+\/topics\/[^/]+$/;

function read(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = read(env, name);
    if (value === undefined) {
      problems.push(`${name} is required but not set`);
      return '';
    }
    return value;
  };

  const optional = (name: string, fallback: string): string => read(env, name) ?? fallback;

  const positiveInt = (name: string, fallback: number): number => {
    const raw = read(env, name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      problems.push(`${name} must be a positive integer (got "${raw}")`);
      return fallback;
    }
    return n;
  };

  const googleClientId = required('GOOGLE_CLIENT_ID');
  const googleClientSecret = required('GOOGLE_CLIENT_SECRET');
  const googleRefreshToken = required('GOOGLE_REFRESH_TOKEN');
  const pubsubTopic = required('PUBSUB_TOPIC');
  if (pubsubTopic && !PUBSUB_TOPIC_RE.test(pubsubTopic)) {
    problems.push(`PUBSUB_TOPIC must look like projects/<project-id>/topics/<topic-name>`);
  }
  const gmailAddress = read(env, 'GMAIL_ADDRESS')?.toLowerCase();
  const webhookSecret = required('WEBHOOK_SECRET');
  const cronSecret = required('CRON_SECRET');
  const openRouterApiKey = required('OPENROUTER_API_KEY');

  const openRouterModel = optional('OPENROUTER_MODEL', DEFAULTS.OPENROUTER_MODEL);
  const openRouterFallbackModels = optional(
    'OPENROUTER_FALLBACK_MODELS',
    DEFAULTS.OPENROUTER_FALLBACK_MODELS,
  )
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && m !== openRouterModel);

  const labelImportant = optional('LABEL_IMPORTANT', DEFAULTS.LABEL_IMPORTANT);
  const labelNeutral = optional('LABEL_NEUTRAL', DEFAULTS.LABEL_NEUTRAL);
  const labelJunk = optional('LABEL_JUNK', DEFAULTS.LABEL_JUNK);
  const labelNames = [labelImportant, labelNeutral, labelJunk];
  if (new Set(labelNames.map((l) => l.toLowerCase())).size !== 3) {
    problems.push('LABEL_IMPORTANT, LABEL_NEUTRAL and LABEL_JUNK must be three distinct names');
  }

  const maxEmailsPerRun = positiveInt('MAX_EMAILS_PER_RUN', DEFAULTS.MAX_EMAILS_PER_RUN);
  const lookbackDays = positiveInt('LOOKBACK_DAYS', DEFAULTS.LOOKBACK_DAYS);
  const bodyMaxChars = positiveInt('BODY_MAX_CHARS', DEFAULTS.BODY_MAX_CHARS);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    googleClientId,
    googleClientSecret,
    googleRefreshToken,
    pubsubTopic,
    gmailAddress,
    webhookSecret,
    cronSecret,
    openRouterApiKey,
    openRouterModel,
    openRouterFallbackModels,
    labelImportant,
    labelNeutral,
    labelJunk,
    maxEmailsPerRun,
    lookbackDays,
    bodyMaxChars,
  };
}
