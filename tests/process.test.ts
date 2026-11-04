import { describe, expect, it, vi } from 'vitest';
import { ClassifierAuthError, RateLimitedError, type Classifier } from '../lib/classify.js';
import { silentLogger } from '../lib/logger.js';
import { processInbox } from '../lib/process.js';
import { fakeGmailService, fullMessage } from './helpers.js';

function minimal(id: string, labelIds: string[]) {
  return { id, labelIds };
}

describe('processInbox', () => {
  it('classifies and labels each unprocessed email sequentially, with correct counts', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a', 'b']);
    gmail.getMessage.mockImplementation(async (id: string, format: string) =>
      format === 'full'
        ? fullMessage(id, `${id}@x.io`, `S-${id}`, 'body')
        : minimal(id, ['INBOX', 'UNREAD']),
    );
    const order: string[] = [];
    const classify = vi.fn(async (email: { subject: string }) => {
      order.push(email.subject);
      return email.subject === 'S-a' ? 'important' : 'junk';
    }) as unknown as Classifier;

    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });

    expect(summary).toEqual({ scanned: 2, labeled: 2, skipped: 0, failed: 0, rateLimited: false });
    expect(order).toEqual(['S-a', 'S-b']);
    expect(gmail.applyLabel).toHaveBeenNthCalledWith(1, 'a', 'Label_1');
    expect(gmail.applyLabel).toHaveBeenNthCalledWith(2, 'b', 'Label_3');
  });

  it('skips an email that gained one of our labels between classify and write', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a']);
    gmail.getMessage.mockImplementation(async (id: string, format: string) =>
      format === 'full' ? fullMessage(id, 'x', 'y', 'z') : minimal(id, ['INBOX', 'Label_2']),
    );
    const classify = vi.fn(async () => 'important' as const);
    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });
    expect(summary).toMatchObject({ scanned: 1, labeled: 0, skipped: 1, failed: 0 });
    expect(gmail.applyLabel).not.toHaveBeenCalled();
  });

  it('skips (never defaults) when the classifier returns null', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a']);
    gmail.getMessage.mockResolvedValue(fullMessage('a', 'x', 'y', 'z'));
    const classify = vi.fn(async () => null);
    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });
    expect(summary).toMatchObject({ scanned: 1, labeled: 0, skipped: 1, failed: 0 });
    expect(gmail.applyLabel).not.toHaveBeenCalled();
    // Only the "full" fetch happened; no minimal re-check needed.
    expect(gmail.getMessage).toHaveBeenCalledTimes(1);
  });

  it('stops the loop on RateLimitedError and reports retryAfterSeconds', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a', 'b', 'c']);
    gmail.getMessage.mockImplementation(async (id: string, format: string) =>
      format === 'full' ? fullMessage(id, 'x', 'y', 'z') : minimal(id, ['INBOX']),
    );
    const classify = vi
      .fn()
      .mockResolvedValueOnce('neutral')
      .mockRejectedValueOnce(new RateLimitedError('m', 30)) as unknown as Classifier;
    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });
    expect(summary).toEqual({
      scanned: 3,
      labeled: 1,
      skipped: 0,
      failed: 0,
      rateLimited: true,
      retryAfterSeconds: 30,
    });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(gmail.applyLabel).toHaveBeenCalledTimes(1);
  });

  it('a failure on one email does not stop the others', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['bad', 'good']);
    gmail.getMessage.mockImplementation(async (id: string, format: string) => {
      if (id === 'bad' && format === 'full') throw new Error('boom');
      return format === 'full' ? fullMessage(id, 'x', 'y', 'z') : minimal(id, ['INBOX']);
    });
    const classify = vi.fn(async () => 'neutral' as const);
    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });
    expect(summary).toMatchObject({
      scanned: 2,
      labeled: 1,
      skipped: 0,
      failed: 1,
      rateLimited: false,
    });
    expect(gmail.applyLabel).toHaveBeenCalledWith('good', 'Label_2');
  });

  it('counts a failed applyLabel as failed and leaves the email for the next run', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a']);
    gmail.getMessage.mockImplementation(async (id: string, format: string) =>
      format === 'full' ? fullMessage(id, 'x', 'y', 'z') : minimal(id, ['INBOX']),
    );
    gmail.applyLabel.mockRejectedValue(new Error('quota'));
    const classify = vi.fn(async () => 'junk' as const);
    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });
    expect(summary).toMatchObject({ labeled: 0, failed: 1 });
  });

  it('stops on ClassifierAuthError and records a fatal error', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a', 'b']);
    gmail.getMessage.mockResolvedValue(fullMessage('a', 'x', 'y', 'z'));
    const classify = vi
      .fn()
      .mockRejectedValue(new ClassifierAuthError(401)) as unknown as Classifier;
    const summary = await processInbox({
      gmail,
      classify,
      bodyMaxChars: 4000,
      logger: silentLogger,
    });
    expect(summary.fatalError).toMatch(/401/);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('passes bodyMaxChars through to extraction', async () => {
    const gmail = fakeGmailService();
    gmail.findUnprocessed.mockResolvedValue(['a']);
    gmail.getMessage.mockImplementation(async (id: string, format: string) =>
      format === 'full' ? fullMessage(id, 'x', 'y', 'z'.repeat(500)) : minimal(id, ['INBOX']),
    );
    const classify = vi.fn(async (email: { body: string }) => {
      expect(email.body).toHaveLength(50);
      return 'neutral' as const;
    });
    await processInbox({ gmail, classify, bodyMaxChars: 50, logger: silentLogger });
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
