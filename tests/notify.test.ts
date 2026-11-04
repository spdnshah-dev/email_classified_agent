import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/gmail/notify.js';
import { VALID_ENV, mockReqRes, pubsubEnvelope } from './helpers.js';

vi.mock('../lib/runtime.js', () => ({
  runProcessing: vi.fn(),
  renewWatch: vi.fn(),
}));

import { runProcessing } from '../lib/runtime.js';
const runProcessingMock = vi.mocked(runProcessing);

const ORIGINAL_ENV = { ...process.env };

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

const goodEnvelope = pubsubEnvelope({ emailAddress: 'me@gmail.com', historyId: '12345' });

describe('POST /api/gmail/notify', () => {
  it('405 for non-POST', async () => {
    const { req, res } = mockReqRes({
      method: 'GET',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(runProcessingMock).not.toHaveBeenCalled();
  });

  it('401 on wrong or missing secret', async () => {
    const cases: Record<string, string | string[]>[] = [{}, { key: 'wrong' }, { key: ['a', 'b'] }];
    for (const query of cases) {
      const { req, res } = mockReqRes({ method: 'POST', query, body: goodEnvelope });
      await handler(req, res);
      expect(res.statusCode).toBe(401);
    }
    expect(runProcessingMock).not.toHaveBeenCalled();
  });

  it('500 with a clear message when config is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      body: goodEnvelope,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ problems: ['OPENROUTER_API_KEY is required but not set'] });
  });

  it('400 on bodies that are not a Pub/Sub push envelope', async () => {
    const bad: unknown[] = [
      undefined,
      'not json at all',
      { hello: 'world' },
      { message: { data: Buffer.from('not-json').toString('base64') } },
      pubsubEnvelope({ historyId: '1' }),
      pubsubEnvelope({ emailAddress: 'me@gmail.com' }),
    ];
    for (const body of bad) {
      const { req, res } = mockReqRes({
        method: 'POST',
        query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
        body,
      });
      await handler(req, res);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      bodyThrows: true,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(runProcessingMock).not.toHaveBeenCalled();
  });

  it('200 with the summary on success', async () => {
    runProcessingMock.mockResolvedValue({
      scanned: 2,
      labeled: 2,
      skipped: 0,
      failed: 0,
      rateLimited: false,
    });
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      body: goodEnvelope,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      summary: { scanned: 2, labeled: 2, skipped: 0, failed: 0, rateLimited: false },
    });
    expect(runProcessingMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a JSON string body and a numeric historyId', async () => {
    runProcessingMock.mockResolvedValue({
      scanned: 0,
      labeled: 0,
      skipped: 0,
      failed: 0,
      rateLimited: false,
    });
    const body = JSON.stringify(pubsubEnvelope({ emailAddress: 'me@gmail.com', historyId: 99 }));
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      body,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('200 even when processing throws, so Pub/Sub does not retry', async () => {
    runProcessingMock.mockRejectedValue(new Error('Gmail label(s) not found: "Junk Emails"'));
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      body: goodEnvelope,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringContaining('Junk Emails') });
  });

  it('ignores notifications for another account when GMAIL_ADDRESS is set', async () => {
    process.env.GMAIL_ADDRESS = 'Me@Gmail.com';
    const other = pubsubEnvelope({ emailAddress: 'someone@else.com', historyId: '1' });
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      body: other,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ignored: true });
    expect(runProcessingMock).not.toHaveBeenCalled();

    runProcessingMock.mockResolvedValue({
      scanned: 0,
      labeled: 0,
      skipped: 0,
      failed: 0,
      rateLimited: false,
    });
    const mine = mockReqRes({
      method: 'POST',
      query: { key: VALID_ENV.WEBHOOK_SECRET ?? '' },
      body: goodEnvelope,
    });
    await handler(mine.req, mine.res);
    expect(mine.res.statusCode).toBe(200);
    expect(runProcessingMock).toHaveBeenCalledTimes(1);
  });
});
