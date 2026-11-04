import { describe, expect, it } from 'vitest';
import { MAX_CANDIDATES_SCANNED, buildSearchQuery, createGmailService } from '../lib/gmail.js';
import { silentLogger } from '../lib/logger.js';
import { LABEL_IDS, fakeGmailApi, serviceConfig } from './helpers.js';

describe('getLabelIds', () => {
  it('maps configured names to IDs case-insensitively and caches', async () => {
    const api = fakeGmailApi();
    const svc = createGmailService(api, serviceConfig, silentLogger);
    await expect(svc.getLabelIds()).resolves.toEqual(LABEL_IDS);
    await svc.getLabelIds();
    expect(api.users.labels.list).toHaveBeenCalledTimes(1);
  });

  it('throws naming the missing label and never creates one', async () => {
    const api = fakeGmailApi({ labels: [{ id: 'Label_1', name: 'Important Emails' }] });
    const svc = createGmailService(api, serviceConfig, silentLogger);
    await expect(svc.getLabelIds()).rejects.toThrow(/"Neutral Emails", "Junk Emails"/);
  });
});

describe('applyLabel', () => {
  it('sends only addLabelIds and never a removeLabelIds key', async () => {
    const api = fakeGmailApi();
    const svc = createGmailService(api, serviceConfig, silentLogger);
    await svc.applyLabel('m1', 'Label_2');
    expect(api.users.messages.modify).toHaveBeenCalledTimes(1);
    const params = api.users.messages.modify.mock.calls[0]?.[0] as {
      userId: string;
      id: string;
      requestBody: Record<string, unknown>;
    };
    expect(params.userId).toBe('me');
    expect(params.id).toBe('m1');
    expect(params.requestBody).toEqual({ addLabelIds: ['Label_2'] });
    expect(params.requestBody).not.toHaveProperty('removeLabelIds');
    expect(Object.keys(params.requestBody)).toEqual(['addLabelIds']);
  });
});

describe('findUnprocessed', () => {
  it('uses the base query and excludes messages that already carry one of the three labels client-side', async () => {
    const api = fakeGmailApi({
      messages: {
        a: { id: 'a', labelIds: ['INBOX', 'UNREAD'], internalDate: '300' },
        b: { id: 'b', labelIds: ['INBOX', 'UNREAD', 'Label_2'], internalDate: '250' },
        c: { id: 'c', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'], internalDate: '200' },
        d: { id: 'd', labelIds: ['INBOX', 'UNREAD', 'Label_3'], internalDate: '150' },
        e: { id: 'e', labelIds: ['INBOX', 'UNREAD'], internalDate: '100' },
      },
    });
    const svc = createGmailService(api, serviceConfig, silentLogger);
    const ids = await svc.findUnprocessed(LABEL_IDS);
    // c carries Gmail's system IMPORTANT label, which is not one of ours.
    expect(ids).toEqual(['a', 'c', 'e']);

    const listParams = api.users.messages.list.mock.calls[0]?.[0];
    expect(listParams?.q).toBe('in:inbox is:unread newer_than:7d');
    expect(listParams?.q).not.toMatch(/label:/);
    for (const call of api.users.messages.get.mock.calls) {
      expect(call[0].format).toBe('minimal');
    }
  });

  it('respects maxEmailsPerRun and returns newest first', async () => {
    const api = fakeGmailApi({
      messages: {
        old: { id: 'old', labelIds: ['INBOX'], internalDate: '1' },
        mid: { id: 'mid', labelIds: ['INBOX'], internalDate: '2' },
        new: { id: 'new', labelIds: ['INBOX'], internalDate: '3' },
      },
      listPages: [{ messages: [{ id: 'old' }, { id: 'mid' }, { id: 'new' }] }],
    });
    const svc = createGmailService(api, { ...serviceConfig, maxEmailsPerRun: 2 }, silentLogger);
    const ids = await svc.findUnprocessed(LABEL_IDS);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('mid');
    // Stops fetching once enough candidates are found.
    expect(api.users.messages.get).toHaveBeenCalledTimes(2);
  });

  it('follows nextPageToken until enough unprocessed messages are found', async () => {
    const api = fakeGmailApi({
      messages: {
        p1: { id: 'p1', labelIds: ['Label_1'] },
        p2: { id: 'p2', labelIds: ['Label_1'] },
        p3: { id: 'p3', labelIds: ['INBOX'] },
      },
      listPages: [
        { messages: [{ id: 'p1' }, { id: 'p2' }], nextPageToken: 'tok' },
        { messages: [{ id: 'p3' }] },
      ],
    });
    const svc = createGmailService(api, serviceConfig, silentLogger);
    await expect(svc.findUnprocessed(LABEL_IDS)).resolves.toEqual(['p3']);
    expect(api.users.messages.list).toHaveBeenCalledTimes(2);
    expect((api.users.messages.list.mock.calls[1]?.[0] as { pageToken?: string }).pageToken).toBe(
      'tok',
    );
  });

  it('never inspects more than MAX_CANDIDATES_SCANNED candidates', async () => {
    const messages: Record<string, { id: string; labelIds: string[] }> = {};
    const page = { messages: [] as Array<{ id: string }>, nextPageToken: 'more' };
    for (let i = 0; i < MAX_CANDIDATES_SCANNED + 50; i += 1) {
      const id = `x${i}`;
      messages[id] = { id, labelIds: ['Label_1'] };
      page.messages.push({ id });
    }
    const api = fakeGmailApi({ messages, listPages: [page] });
    const svc = createGmailService(api, serviceConfig, silentLogger);
    await expect(svc.findUnprocessed(LABEL_IDS)).resolves.toEqual([]);
    expect(api.users.messages.get).toHaveBeenCalledTimes(MAX_CANDIDATES_SCANNED);
  });
});

describe('registerWatch', () => {
  it('calls users.watch with topic, INBOX and labelFilterBehavior INCLUDE and returns ISO expiration', async () => {
    const api = fakeGmailApi();
    const svc = createGmailService(api, serviceConfig, silentLogger);
    const result = await svc.registerWatch();
    expect(api.users.watch).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: {
        topicName: 'projects/p/topics/t',
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
      },
    });
    expect(result).toEqual({ expiration: '2023-11-14T22:13:20.000Z', historyId: '42' });
  });
});

describe('buildSearchQuery', () => {
  it('encodes lookback days', () => {
    expect(buildSearchQuery(3)).toBe('in:inbox is:unread newer_than:3d');
  });
});
