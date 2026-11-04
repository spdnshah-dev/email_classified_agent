import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/cron/daily.js';
import { VALID_ENV, mockReqRes } from './helpers.js';

vi.mock('../lib/runtime.js', () => ({
  runProcessing: vi.fn(),
  renewWatch: vi.fn(),
}));

import { renewWatch, runProcessing } from '../lib/runtime.js';
const runProcessingMock = vi.mocked(runProcessing);
const renewWatchMock = vi.mocked(renewWatch);

const ORIGINAL_ENV = { ...process.env };
const auth = { authorization: `Bearer ${VALID_ENV.CRON_SECRET}` };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ...VALID_ENV };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('GET /api/cron/daily', () => {
  it('405 for non-GET', async () => {
    const { req, res } = mockReqRes({ method: 'POST', headers: auth });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('401 without a bearer token or with the wrong one', async () => {
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Bearer nope' },
      { authorization: VALID_ENV.CRON_SECRET ?? '' },
    ];
    for (const headers of cases) {
      const { req, res } = mockReqRes({ method: 'GET', headers });
      await handler(req, res);
      expect(res.statusCode).toBe(401);
    }
    expect(renewWatchMock).not.toHaveBeenCalled();
    expect(runProcessingMock).not.toHaveBeenCalled();
  });

  it('500 when config is missing', async () => {
    delete process.env.CRON_SECRET;
    const { req, res } = mockReqRes({ method: 'GET', headers: auth });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it('200 with watch expiration and sweep summary', async () => {
    renewWatchMock.mockResolvedValue({ expiration: '2026-11-11T03:00:00.000Z', historyId: '7' });
    runProcessingMock.mockResolvedValue({
      scanned: 1,
      labeled: 1,
      skipped: 0,
      failed: 0,
      rateLimited: false,
    });
    const { req, res } = mockReqRes({ method: 'GET', headers: auth });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      watch: { expiration: '2026-11-11T03:00:00.000Z', historyId: '7' },
      watchError: undefined,
      summary: { scanned: 1, labeled: 1, skipped: 0, failed: 0, rateLimited: false },
      sweepError: undefined,
    });
    expect(renewWatchMock).toHaveBeenCalledTimes(1);
    expect(runProcessingMock).toHaveBeenCalledTimes(1);
  });

  it('still sweeps when the watch renewal fails, and reports 500', async () => {
    renewWatchMock.mockRejectedValue(new Error('topic missing'));
    runProcessingMock.mockResolvedValue({
      scanned: 0,
      labeled: 0,
      skipped: 0,
      failed: 0,
      rateLimited: false,
    });
    const { req, res } = mockReqRes({ method: 'GET', headers: auth });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      watchError: 'topic missing',
      summary: { scanned: 0 },
    });
    expect(runProcessingMock).toHaveBeenCalledTimes(1);
  });
});
