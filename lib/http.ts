/**
 * Small helpers shared by the Vercel handlers.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ConfigError, loadConfig, type Config } from './config.js';
import type { Logger } from './logger.js';
import { serialiseError } from './logger.js';

/** Constant-time string comparison (hashes first so lengths never leak). */
export function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function bearerToken(req: VercelRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/** Load config, or send a 500 with a clear message and return undefined. */
export function configOr500(res: VercelResponse, log: Logger): Config | undefined {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('config.invalid', { problems: err.problems });
      res.status(500).json({ error: 'Server misconfigured', problems: err.problems });
    } else {
      log.error('config.unexpected', { error: serialiseError(err) });
      res.status(500).json({ error: 'Server misconfigured' });
    }
    return undefined;
  }
}

export interface PubSubNotification {
  emailAddress: string;
  historyId: string;
  messageId?: string;
  publishTime?: string;
  subscription?: string;
}

/**
 * Validate a Pub/Sub push envelope and decode Gmail's payload.
 * Returns a string describing the problem when the body is not a valid envelope.
 */
export function parsePubSubEnvelope(
  body: unknown,
): { ok: true; value: PubSubNotification } | { ok: false; reason: string } {
  let envelope: unknown = body;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return { ok: false, reason: 'body is not JSON' };
    }
  }
  if (!envelope || typeof envelope !== 'object')
    return { ok: false, reason: 'body is not an object' };
  const message = (envelope as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return { ok: false, reason: 'missing message' };
  const data = (message as { data?: unknown }).data;
  if (typeof data !== 'string' || data.length === 0)
    return { ok: false, reason: 'missing message.data' };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'message.data is not base64-encoded JSON' };
  }
  if (!decoded || typeof decoded !== 'object')
    return { ok: false, reason: 'message.data is not an object' };
  const emailAddress = (decoded as { emailAddress?: unknown }).emailAddress;
  const historyId = (decoded as { historyId?: unknown }).historyId;
  if (typeof emailAddress !== 'string' || emailAddress.length === 0) {
    return { ok: false, reason: 'message.data lacks emailAddress' };
  }
  if (typeof historyId !== 'string' && typeof historyId !== 'number') {
    return { ok: false, reason: 'message.data lacks historyId' };
  }

  const m = message as { messageId?: unknown; publishTime?: unknown };
  const subscription = (envelope as { subscription?: unknown }).subscription;
  return {
    ok: true,
    value: {
      emailAddress,
      historyId: String(historyId),
      messageId: typeof m.messageId === 'string' ? m.messageId : undefined,
      publishTime: typeof m.publishTime === 'string' ? m.publishTime : undefined,
      subscription: typeof subscription === 'string' ? subscription : undefined,
    },
  };
}
