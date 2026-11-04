/**
 * GET /api/cron/daily  (Authorization: Bearer <CRON_SECRET>)
 * Renews the Gmail watch (expires every 7 days) and runs a safety sweep.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bearerToken, configOr500, secretsMatch } from '../../lib/http.js';
import { logger, serialiseError } from '../../lib/logger.js';
import { renewWatch, runProcessing } from '../../lib/runtime.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = logger.child({ route: 'cron/daily' });

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const config = configOr500(res, log);
  if (!config) return;

  if (!secretsMatch(bearerToken(req), config.cronSecret)) {
    log.warn('cron.unauthorized');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let watch: { expiration: string; historyId?: string } | undefined;
  let watchError: string | undefined;
  try {
    watch = await renewWatch(config, log);
  } catch (err) {
    watchError = err instanceof Error ? err.message : String(err);
    log.error('cron.watch_failed', { error: serialiseError(err) });
  }

  let summary;
  let sweepError: string | undefined;
  try {
    summary = await runProcessing(config, log);
  } catch (err) {
    sweepError = err instanceof Error ? err.message : String(err);
    log.error('cron.sweep_failed', { error: serialiseError(err) });
  }

  const ok = !watchError && !sweepError;
  res.status(ok ? 200 : 500).json({
    ok,
    watch: watch ?? null,
    watchError,
    summary: summary ?? null,
    sweepError,
  });
}
