import { describe, expect, it } from 'vitest';
import { collapseWhitespace, decodeEntities, extractEmail, htmlToText } from '../lib/extract.js';
import { b64url } from './helpers.js';

const opts = { bodyMaxChars: 4000 };

describe('extractEmail', () => {
  it('reads headers and a plain-text body', () => {
    const email = extractEmail(
      {
        id: 'm1',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Alice <alice@example.com>' },
            { name: 'subject', value: 'Hello' },
            { name: 'Date', value: 'Mon, 3 Nov 2026 10:00:00 +0000' },
          ],
          body: { data: b64url('Hi there,\r\n\r\nSee you soon.') },
        },
      },
      opts,
    );
    expect(email).toEqual({
      id: 'm1',
      from: 'Alice <alice@example.com>',
      subject: 'Hello',
      date: 'Mon, 3 Nov 2026 10:00:00 +0000',
      body: 'Hi there,\n\nSee you soon.',
      attachmentNames: [],
    });
  });

  it('strips tags, style and script from an HTML-only message and decodes entities', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head><body>' +
      '<script>alert(1)</script><p>Dear&nbsp;user,</p><p>Your &quot;order&quot; &amp; invoice &#8364;5 &#x41;</p>' +
      '<a href="x">Click</a></body></html>';
    const email = extractEmail(
      { id: 'm2', payload: { mimeType: 'text/html', body: { data: b64url(html) } } },
      opts,
    );
    expect(email.body).toBe('Dear user,\nYour "order" & invoice €5 A\nClick');
    expect(email.body).not.toMatch(/alert|color/);
  });

  it('prefers text/plain over text/html in nested multipart and collects attachment names', () => {
    const message = {
      id: 'm3',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'Nested' }],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('plain wins') } },
              { mimeType: 'text/html', body: { data: b64url('<b>html loses</b>') } },
            ],
          },
          {
            mimeType: 'application/pdf',
            filename: 'invoice.pdf',
            body: { attachmentId: 'att-1', size: 1234 },
          },
          {
            mimeType: 'image/png',
            filename: 'logo.png',
            body: { attachmentId: 'att-2', size: 99, data: b64url('BINARY-NOT-TEXT') },
          },
        ],
      },
    };
    const email = extractEmail(message, opts);
    expect(email.subject).toBe('Nested');
    expect(email.body).toBe('plain wins');
    expect(email.attachmentNames).toEqual(['invoice.pdf', 'logo.png']);
    expect(email.body).not.toContain('BINARY');
  });

  it('decodes base64url bodies (with - and _ characters)', () => {
    const text = 'ÿþ~~??>>'; // produces +, / in standard base64
    const data = Buffer.from(text, 'utf8').toString('base64url');
    expect(data).toMatch(/[-_]/);
    const email = extractEmail(
      { id: 'm4', payload: { mimeType: 'text/plain', body: { data } } },
      opts,
    );
    expect(email.body).toBe(text);
  });

  it('truncates the body to bodyMaxChars', () => {
    const long = 'a'.repeat(10_000);
    const email = extractEmail(
      { id: 'm5', payload: { mimeType: 'text/plain', body: { data: b64url(long) } } },
      { bodyMaxChars: 100 },
    );
    expect(email.body).toHaveLength(100);
  });

  it('falls back to the snippet when there is no text part', () => {
    const email = extractEmail(
      { id: 'm6', snippet: 'Snippet &amp; more', payload: { mimeType: 'image/png', body: {} } },
      opts,
    );
    expect(email.body).toBe('Snippet & more');
  });
});

describe('helpers', () => {
  it('decodeEntities handles named, decimal and hex entities and leaves unknown ones', () => {
    expect(decodeEntities('&lt;a&gt; &#65;&#x42; &unknown; &amp;')).toBe('<a> AB &unknown; &');
  });

  it('collapseWhitespace squeezes runs but keeps paragraph breaks', () => {
    expect(collapseWhitespace('  a \t b\r\n\r\n\r\n\r\n c  ')).toBe('a b\n\nc');
  });

  it('htmlToText turns block closers and <br> into newlines', () => {
    expect(collapseWhitespace(htmlToText('<div>one</div><p>two<br>three</p>'))).toBe(
      'one\ntwo\nthree',
    );
  });
});
