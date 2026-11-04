/**
 * Gmail access: OAuth2 client construction, label lookup, candidate search,
 * message fetch, label application and push-notification watch registration.
 *
 * Everything that touches the network goes through the narrow `GmailApi`
 * interface so tests can supply a fake instead of the real googleapis client.
 */
import { google, type gmail_v1 } from 'googleapis';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { logger as defaultLogger } from './logger.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export type MessageFormat = 'minimal' | 'full' | 'metadata' | 'raw';
export type LabelKey = 'important' | 'neutral' | 'junk';
export type LabelIds = Record<LabelKey, string>;

export interface WatchResult {
  /** ISO-8601 timestamp after which Gmail stops publishing notifications. */
  expiration: string;
  historyId: string | undefined;
}

/** The subset of the googleapis Gmail client that this project uses. */
export interface GmailApi {
  users: {
    labels: {
      list(
        params: gmail_v1.Params$Resource$Users$Labels$List,
      ): Promise<{ data: gmail_v1.Schema$ListLabelsResponse }>;
    };
    messages: {
      list(
        params: gmail_v1.Params$Resource$Users$Messages$List,
      ): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
      get(
        params: gmail_v1.Params$Resource$Users$Messages$Get,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
      modify(
        params: gmail_v1.Params$Resource$Users$Messages$Modify,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
    };
    watch(
      params: gmail_v1.Params$Resource$Users$Watch,
    ): Promise<{ data: gmail_v1.Schema$WatchResponse }>;
  };
}

export interface GmailService {
  getLabelIds(): Promise<LabelIds>;
  findUnprocessed(labelIds: LabelIds): Promise<string[]>;
  getMessage(id: string, format: MessageFormat): Promise<gmail_v1.Schema$Message>;
  applyLabel(id: string, labelId: string): Promise<void>;
  registerWatch(): Promise<WatchResult>;
}

export type GmailServiceConfig = Pick<
  Config,
  | 'labelImportant'
  | 'labelNeutral'
  | 'labelJunk'
  | 'maxEmailsPerRun'
  | 'lookbackDays'
  | 'pubsubTopic'
>;

/**
 * Upper bound on how many list candidates are inspected per run. Once the agent
 * has been running for a while most unread inbox mail already carries a label,
 * so this bound keeps a single invocation's Gmail call count predictable.
 */
export const MAX_CANDIDATES_SCANNED = 200;
const LIST_PAGE_SIZE = 50;

export function createOAuthClient(
  config: Pick<Config, 'googleClientId' | 'googleClientSecret' | 'googleRefreshToken'>,
) {
  const client = new google.auth.OAuth2({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  client.setCredentials({ refresh_token: config.googleRefreshToken });
  return client;
}

export function createGmailApi(
  config: Pick<Config, 'googleClientId' | 'googleClientSecret' | 'googleRefreshToken'>,
): GmailApi {
  const auth = createOAuthClient(config);
  // gmail_v1.Gmail's methods carry callback overloads; the promise overload
  // satisfies GmailApi structurally, the cast only drops the extra overloads.
  return google.gmail({ version: 'v1', auth }) as unknown as GmailApi;
}

export function buildSearchQuery(lookbackDays: number): string {
  return `in:inbox is:unread newer_than:${lookbackDays}d`;
}

export function createGmailService(
  api: GmailApi,
  config: GmailServiceConfig,
  log: Logger = defaultLogger,
): GmailService {
  let labelIdsCache: Promise<LabelIds> | undefined;

  async function lookupLabelIds(): Promise<LabelIds> {
    const res = await api.users.labels.list({ userId: 'me' });
    const labels = res.data.labels ?? [];
    const byName = new Map<string, string>();
    for (const label of labels) {
      if (label.name && label.id) byName.set(label.name.toLowerCase(), label.id);
    }
    const wanted: Array<[LabelKey, string]> = [
      ['important', config.labelImportant],
      ['neutral', config.labelNeutral],
      ['junk', config.labelJunk],
    ];
    const missing: string[] = [];
    const out: Partial<LabelIds> = {};
    for (const [key, name] of wanted) {
      const id = byName.get(name.toLowerCase());
      if (!id) missing.push(name);
      else out[key] = id;
    }
    if (missing.length > 0) {
      throw new Error(
        `Gmail label(s) not found: ${missing.map((m) => `"${m}"`).join(', ')}. ` +
          'Create them in Gmail first (the agent never creates labels), or fix LABEL_* env vars.',
      );
    }
    return out as LabelIds;
  }

  const service: GmailService = {
    getLabelIds() {
      if (!labelIdsCache) {
        labelIdsCache = lookupLabelIds().catch((err: unknown) => {
          labelIdsCache = undefined; // do not cache failures
          throw err;
        });
      }
      return labelIdsCache;
    },

    async findUnprocessed(labelIds) {
      const exclude = new Set<string>(Object.values(labelIds));
      const query = buildSearchQuery(config.lookbackDays);
      const found: Array<{ id: string; internalDate: number; order: number }> = [];
      let pageToken: string | undefined;
      let scanned = 0;

      do {
        const res = await api.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: LIST_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
        });
        const candidates = res.data.messages ?? [];
        for (const candidate of candidates) {
          if (!candidate.id) continue;
          if (scanned >= MAX_CANDIDATES_SCANNED) break;
          scanned += 1;
          const minimal = await api.users.messages.get({
            userId: 'me',
            id: candidate.id,
            format: 'minimal',
          });
          const current = minimal.data.labelIds ?? [];
          if (current.some((l) => exclude.has(l))) continue;
          const internalDate = Number(minimal.data.internalDate ?? 0);
          found.push({ id: candidate.id, internalDate, order: found.length });
          if (found.length >= config.maxEmailsPerRun) break;
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (
        pageToken &&
        found.length < config.maxEmailsPerRun &&
        scanned < MAX_CANDIDATES_SCANNED
      );

      // Gmail lists newest first in practice; when internalDate is available
      // sort explicitly, otherwise keep the API order (stable sort).
      found.sort((a, b) => b.internalDate - a.internalDate || a.order - b.order);
      const ids = found.slice(0, config.maxEmailsPerRun).map((f) => f.id);
      log.info('gmail.findUnprocessed', { query, scanned, unprocessed: ids.length });
      return ids;
    },

    async getMessage(id, format) {
      const res = await api.users.messages.get({ userId: 'me', id, format });
      return res.data;
    },

    async applyLabel(id, labelId) {
      // Deliberately no `removeLabelIds` key: the message must stay unread and
      // keep every label it already has.
      await api.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { addLabelIds: [labelId] },
      });
    },

    async registerWatch() {
      const res = await api.users.watch({
        userId: 'me',
        requestBody: {
          topicName: config.pubsubTopic,
          labelIds: ['INBOX'],
          labelFilterBehavior: 'INCLUDE',
        },
      });
      const expirationMs = Number(res.data.expiration ?? NaN);
      const expiration = Number.isFinite(expirationMs)
        ? new Date(expirationMs).toISOString()
        : 'unknown';
      log.info('gmail.watch.registered', {
        topic: config.pubsubTopic,
        expiration,
        historyId: res.data.historyId ?? undefined,
      });
      return { expiration, historyId: res.data.historyId ?? undefined };
    },
  };

  return service;
}
