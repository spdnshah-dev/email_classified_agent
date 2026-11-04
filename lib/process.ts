/**
 * The shared processing loop: find unprocessed mail → classify → label.
 * Stateless by design; "processed" is represented by the label itself.
 */
import type { Classifier } from './classify.js';
import { ClassifierAuthError, RateLimitedError } from './classify.js';
import { extractEmail } from './extract.js';
import type { GmailService, LabelIds } from './gmail.js';
import type { Logger } from './logger.js';
import { logger as defaultLogger, serialiseError } from './logger.js';

export interface ProcessSummary {
  scanned: number;
  labeled: number;
  skipped: number;
  failed: number;
  rateLimited: boolean;
  retryAfterSeconds?: number;
  fatalError?: string;
}

export interface ProcessDeps {
  gmail: GmailService;
  classify: Classifier;
  bodyMaxChars: number;
  logger?: Logger;
}

export async function processInbox(deps: ProcessDeps): Promise<ProcessSummary> {
  const log = deps.logger ?? defaultLogger;
  const summary: ProcessSummary = {
    scanned: 0,
    labeled: 0,
    skipped: 0,
    failed: 0,
    rateLimited: false,
  };

  const labelIds: LabelIds = await deps.gmail.getLabelIds();
  const ids = await deps.gmail.findUnprocessed(labelIds);
  const known = new Set<string>(Object.values(labelIds));
  summary.scanned = ids.length;

  for (const id of ids) {
    try {
      const message = await deps.gmail.getMessage(id, 'full');
      const email = extractEmail(message, { bodyMaxChars: deps.bodyMaxChars });

      const label = await deps.classify(email);
      if (label === null) {
        summary.skipped += 1;
        log.warn('process.skip.unclassified', { id, from: email.from, subject: email.subject });
        continue;
      }

      // Re-check right before writing: another invocation may have labelled it.
      const fresh = await deps.gmail.getMessage(id, 'minimal');
      const current = fresh.labelIds ?? [];
      if (current.some((l) => known.has(l))) {
        summary.skipped += 1;
        log.info('process.skip.race', { id, from: email.from, subject: email.subject });
        continue;
      }

      await deps.gmail.applyLabel(id, labelIds[label]);
      summary.labeled += 1;
      log.info('process.labeled', { id, from: email.from, subject: email.subject, label });
    } catch (err) {
      if (err instanceof RateLimitedError) {
        summary.rateLimited = true;
        if (err.retryAfterSeconds !== undefined) summary.retryAfterSeconds = err.retryAfterSeconds;
        log.warn('process.stop.rate_limited', { id, retryAfterSeconds: err.retryAfterSeconds });
        break;
      }
      if (err instanceof ClassifierAuthError) {
        summary.fatalError = err.message;
        log.error('process.stop.fatal', { id, error: serialiseError(err) });
        break;
      }
      summary.failed += 1;
      log.error('process.email_failed', { id, error: serialiseError(err) });
      // Leave the email untouched; the next notification or daily sweep retries it.
    }
  }

  log.info('process.summary', { ...summary });
  return summary;
}
