import { describe, expect, it } from 'vitest';
import { parsePubSubEnvelope, secretsMatch } from '../lib/http.js';

describe('secretsMatch', () => {
  it('matches equal strings only', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abd', 'abc')).toBe(false);
    expect(secretsMatch('abcd', 'abc')).toBe(false);
    expect(secretsMatch(undefined, 'abc')).toBe(false);
    expect(secretsMatch(['abc'], 'abc')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });
});

describe('parsePubSubEnvelope', () => {
  it('decodes standard base64 and base64url payloads', () => {
    const payload = JSON.stringify({ emailAddress: 'me@gmail.com', historyId: '5' });
    for (const encoding of ['base64', 'base64url'] as const) {
      const result = parsePubSubEnvelope({
        message: { data: Buffer.from(payload).toString(encoding) },
      });
      expect(result).toEqual({
        ok: true,
        value: {
          emailAddress: 'me@gmail.com',
          historyId: '5',
          messageId: undefined,
          publishTime: undefined,
          subscription: undefined,
        },
      });
    }
  });

  it('reports why an envelope is invalid', () => {
    expect(parsePubSubEnvelope(null)).toMatchObject({ ok: false });
    expect(parsePubSubEnvelope({ message: {} })).toMatchObject({
      ok: false,
      reason: 'missing message.data',
    });
    expect(parsePubSubEnvelope({ message: { data: 'e30=' } })).toMatchObject({
      ok: false,
      reason: 'message.data lacks emailAddress',
    });
  });
});
