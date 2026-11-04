import { describe, expect, it, vi } from 'vitest';
import {
  APP_TITLE,
  ClassifierAuthError,
  OPENROUTER_URL,
  RateLimitedError,
  REPO_URL,
  TOOL_NAME,
  createClassifier,
  labelFromText,
  parseLabel,
} from '../lib/classify.js';
import { silentLogger } from '../lib/logger.js';
import { jsonResponse, toolCallResponse } from './helpers.js';

const email = {
  from: 'Bank <alerts@bank.example>',
  subject: 'Security alert',
  date: 'Mon, 3 Nov 2026 10:00:00 +0000',
  body: 'A new device signed in.',
  attachmentNames: [],
};

const PRIMARY = 'nvidia/nemotron-3.5-lightning:free';
const FALLBACKS = ['xingchen-agi/xing4.0-29b-a4b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'];

function make(
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createClassifier>[0]> = {},
) {
  return createClassifier({
    apiKey: 'sk-or-test',
    model: PRIMARY,
    fallbackModels: FALLBACKS,
    fetchImpl,
    logger: silentLogger,
    ...extra,
  });
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('createClassifier', () => {
  it('parses the forced tool call', async () => {
    const fetchMock = vi.fn(async () => toolCallResponse('important'));
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).resolves.toBe('important');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the expected request: endpoint, headers, tool_choice, reasoning disabled, temperature 0', async () => {
    const fetchMock = vi.fn(async () => toolCallResponse('neutral'));
    const classify = make(fetchMock as unknown as typeof fetch);
    await classify(email);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test');
    expect(headers['HTTP-Referer']).toBe(REPO_URL);
    expect(headers['X-Title']).toBe(APP_TITLE);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = sentBody(fetchMock);
    expect(body.model).toBe(PRIMARY);
    expect(body.models).toEqual([PRIMARY, ...FALLBACKS]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: TOOL_NAME } });
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.temperature).toBe(0);
    expect(body).not.toHaveProperty('response_format');
    const tools = body.tools as Array<{
      function: {
        name: string;
        parameters: { properties: { label: { enum: string[] } }; required: string[] };
      };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function.name).toBe(TOOL_NAME);
    expect(tools[0]?.function.parameters.properties.label.enum).toEqual([
      'important',
      'neutral',
      'junk',
    ]);
    expect(tools[0]?.function.parameters.required).toEqual(['label']);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[1]?.content).toContain('From: Bank <alerts@bank.example>');
    expect(messages[1]?.content).toContain('Subject: Security alert');
    expect(messages[1]?.content).toContain('A new device signed in.');
  });

  it('falls back to scanning text content when there is no tool call', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'This looks like JUNK.' } }],
      }),
    );
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).resolves.toBe('junk');
  });

  it('returns null on garbage after exhausting all models', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'important or neutral?' } }] }),
    );
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(fetchMock, 1).model).toBe(FALLBACKS[0]);
    expect(sentBody(fetchMock, 2).model).toBe(FALLBACKS[1]);
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('models');
  });

  it('tries the next model on HTTP 404 and 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('no endpoints', { status: 404 }))
      .mockResolvedValueOnce(new Response('upstream', { status: 502 }))
      .mockResolvedValueOnce(toolCallResponse('neutral', FALLBACKS[1]));
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).resolves.toBe('neutral');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(fetchMock, 0).model).toBe(PRIMARY);
    expect(sentBody(fetchMock, 1).model).toBe(FALLBACKS[0]);
    expect(sentBody(fetchMock, 1).models).toEqual(FALLBACKS);
    expect(sentBody(fetchMock, 2).model).toBe(FALLBACKS[1]);
  });

  it('tries the next model on network error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(toolCallResponse('important'));
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).resolves.toBe('important');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts after the timeout and tries the next model', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      )
      .mockResolvedValueOnce(toolCallResponse('neutral'));
    const classify = make(fetchMock as unknown as typeof fetch, { timeoutMs: 20 });
    await expect(classify(email)).resolves.toBe('neutral');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws RateLimitedError on 429 without trying other models, exposing Retry-After', async () => {
    const fetchMock = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '37' } }),
    );
    const classify = make(fetchMock as unknown as typeof fetch);
    const err = await classify(email).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(37);
    expect((err as RateLimitedError).model).toBe(PRIMARY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ClassifierAuthError on 401', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).rejects.toBeInstanceOf(ClassifierAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tries the next model when the body is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>oops</html>', { status: 200 }))
      .mockResolvedValueOnce(toolCallResponse('junk'));
    const classify = make(fetchMock as unknown as typeof fetch);
    await expect(classify(email)).resolves.toBe('junk');
  });
});

describe('parseLabel', () => {
  it('accepts tool arguments passed as an object', () => {
    expect(
      parseLabel({
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: TOOL_NAME, arguments: { label: 'Neutral' } } }],
            },
          },
        ],
      }),
    ).toBe('neutral');
  });

  it('ignores tool calls to other functions', () => {
    expect(
      parseLabel({
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: 'other', arguments: '{"label":"junk"}' } }],
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it('returns null for empty or malformed bodies', () => {
    expect(parseLabel(null)).toBeNull();
    expect(parseLabel({})).toBeNull();
    expect(parseLabel({ choices: [] })).toBeNull();
    expect(parseLabel({ choices: [{ message: { content: '' } }] })).toBeNull();
  });
});

describe('labelFromText', () => {
  it('needs exactly one distinct label word, case-insensitively', () => {
    expect(labelFromText('Important!')).toBe('important');
    expect(labelFromText('neutral neutral')).toBe('neutral');
    expect(labelFromText('important but maybe junk')).toBeNull();
    expect(labelFromText('unimportant')).toBeNull();
    expect(labelFromText('')).toBeNull();
  });
});
