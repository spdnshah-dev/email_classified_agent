import type { gmail_v1 } from 'googleapis';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { vi } from 'vitest';
import type { GmailApi, GmailService, GmailServiceConfig } from '../lib/gmail.js';

export const serviceConfig: GmailServiceConfig = {
  labelImportant: 'Important Emails',
  labelNeutral: 'Neutral Emails',
  labelJunk: 'Junk Emails',
  maxEmailsPerRun: 15,
  lookbackDays: 7,
  pubsubTopic: 'projects/p/topics/t',
};

export const LABEL_IDS = { important: 'Label_1', neutral: 'Label_2', junk: 'Label_3' } as const;

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function fakeGmailApi(
  overrides: Partial<{
    labels: gmail_v1.Schema$Label[];
    messages: Record<string, gmail_v1.Schema$Message>;
    listPages: gmail_v1.Schema$ListMessagesResponse[];
  }> = {},
) {
  const labels = overrides.labels ?? [
    { id: 'Label_1', name: 'Important Emails' },
    { id: 'Label_2', name: 'Neutral Emails' },
    { id: 'Label_3', name: 'Junk Emails' },
    { id: 'IMPORTANT', name: 'IMPORTANT' },
  ];
  const messages = overrides.messages ?? {};
  const listPages = overrides.listPages ?? [
    { messages: Object.keys(messages).map((id) => ({ id })) },
  ];
  let page = 0;

  const api = {
    users: {
      labels: { list: vi.fn(async () => ({ data: { labels } })) },
      messages: {
        list: vi.fn(async (_params: gmail_v1.Params$Resource$Users$Messages$List) => {
          const data = listPages[Math.min(page, listPages.length - 1)] ?? {};
          page += 1;
          return { data };
        }),
        get: vi.fn(async (params: gmail_v1.Params$Resource$Users$Messages$Get) => {
          const msg = messages[params.id ?? ''];
          if (!msg) throw new Error(`no such message ${params.id}`);
          return { data: msg };
        }),
        modify: vi.fn(async (params: gmail_v1.Params$Resource$Users$Messages$Modify) => ({
          data: { id: params.id },
        })),
      },
      watch: vi.fn(async () => ({ data: { expiration: '1700000000000', historyId: '42' } })),
    },
  };
  return api as unknown as GmailApi & typeof api;
}

export function fakeGmailService(): GmailService & {
  getLabelIds: ReturnType<typeof vi.fn>;
  findUnprocessed: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  applyLabel: ReturnType<typeof vi.fn>;
  registerWatch: ReturnType<typeof vi.fn>;
} {
  return {
    getLabelIds: vi.fn(async () => ({ ...LABEL_IDS })),
    findUnprocessed: vi.fn(async () => []),
    getMessage: vi.fn(async () => ({})),
    applyLabel: vi.fn(async () => undefined),
    registerWatch: vi.fn(async () => ({ expiration: '2030-01-01T00:00:00.000Z', historyId: '1' })),
  };
}

export function fullMessage(
  id: string,
  from: string,
  subject: string,
  body: string,
): gmail_v1.Schema$Message {
  return {
    id,
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Mon, 3 Nov 2026 10:00:00 +0000' },
      ],
      body: { data: b64url(body) },
    },
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export function toolCallResponse(
  label: string,
  model = 'nvidia/nemotron-3.5-lightning:free',
): Response {
  return jsonResponse({
    id: 'gen-1',
    model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'set_label', arguments: JSON.stringify({ label }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
}

export interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

export function mockReqRes(init: {
  method?: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyThrows?: boolean;
}) {
  const req: Record<string, unknown> = {
    method: init.method ?? 'GET',
    query: init.query ?? {},
    headers: init.headers ?? {},
  };
  if (init.bodyThrows) {
    Object.defineProperty(req, 'body', {
      get() {
        throw new Error('Invalid JSON');
      },
    });
  } else {
    req.body = init.body;
  }
  const res: MockRes & Record<string, unknown> = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    send(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    end() {
      return res;
    },
  };
  return { req: req as unknown as VercelRequest, res: res as unknown as VercelResponse & MockRes };
}

export const VALID_ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  GOOGLE_REFRESH_TOKEN: 'rtoken',
  PUBSUB_TOPIC: 'projects/my-proj/topics/gmail-push',
  WEBHOOK_SECRET: 'webhook-secret-123',
  CRON_SECRET: 'cron-secret-456',
  OPENROUTER_API_KEY: 'sk-or-test',
};

export function pubsubEnvelope(payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      messageId: 'm-1',
      publishTime: '2026-11-04T00:00:00Z',
      ...extra,
    },
    subscription: 'projects/my-proj/subscriptions/gmail-push-sub',
  };
}
