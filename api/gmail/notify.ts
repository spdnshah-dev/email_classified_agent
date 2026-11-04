/**
 * POST /api/gmail/notify?key=<WEBHOOK_SECRET>
 * Pub/Sub push target for Gmail notifications. Runs the processing loop.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { configOr500, firstQueryValue, parsePubSubEnvelope, secretsMatch } from '../../lib/http.js';
import { logger, serialiseError } from '../../lib/logger.js';
import { runProcessing } from '../../lib/runtime.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = logger.child({ route: 'gmail/notify' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const config = configOr500(res, log);
  if (!config) return;

  if (!secretsMatch(firstQueryValue(req.query.key), config.webhookSecret)) {
    log.warn('notify.unauthorized');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let body: unknown;
  try {
    body = req.body; // getter; throws on malformed JSON
  } catch {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  const envelope = parsePubSubEnvelope(body);
  if (!envelope.ok) {
    log.warn('notify.bad_envelope', { reason: envelope.reason });
    res.status(400).json({ error: `Invalid Pub/Sub envelope: ${envelope.reason}` });
    return;
  }

  const { emailAddress, historyId, messageId, publishTime } = envelope.value;
  log.info('notify.received', { emailAddress, historyId, messageId, publishTime });

  if (config.gmailAddress && emailAddress.toLowerCase() !== config.gmailAddress) {
    log.warn('notify.ignored_other_account', { emailAddress });
    res.status(200).json({ ok: true, ignored: true, reason: 'emailAddress mismatch' });
    return;
  }

  // From here on always answer 200 so Pub/Sub does not retry; our next
  // notification or the daily sweep picks up anything left unlabelled.
  try {
    const summary = await runProcessing(config, log);
    res.status(200).json({ ok: true, summary });
  } catch (err) {
    log.error('notify.processing_failed', { error: serialiseError(err) });
    res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
