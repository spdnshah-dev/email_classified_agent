/**
 * Turn a Gmail `users.messages.get(format=full)` payload into the small,
 * plain-text shape the classifier consumes.
 */
import type { gmail_v1 } from 'googleapis';

export interface ExtractedEmail {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  attachmentNames: string[];
}

export interface ExtractOptions {
  bodyMaxChars: number;
}

type Part = gmail_v1.Schema$MessagePart;

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  const lower = name.toLowerCase();
  const hit = headers?.find((h) => h.name?.toLowerCase() === lower);
  return (hit?.value ?? '').trim();
}

export function decodeBase64Url(data: string): string {
  // Node's base64 decoder accepts both the standard and the URL-safe alphabet.
  return Buffer.from(data, 'base64').toString('utf8');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  euro: '€',
  pound: '£',
  yen: '¥',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text;
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: string[];
}

function walk(part: Part | undefined, acc: Collected): void {
  if (!part) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = (part.filename ?? '').trim();

  if (filename.length > 0) {
    acc.attachments.push(filename);
    // Attachment contents are never read.
  } else if (part.body?.data) {
    if (mime === 'text/plain') acc.plain.push(decodeBase64Url(part.body.data));
    else if (mime === 'text/html') acc.html.push(decodeBase64Url(part.body.data));
  }

  for (const child of part.parts ?? []) walk(child, acc);
}

export function extractEmail(
  message: gmail_v1.Schema$Message,
  options: ExtractOptions,
): ExtractedEmail {
  const payload = message.payload;
  const headers = payload?.headers ?? undefined;

  const acc: Collected = { plain: [], html: [], attachments: [] };
  walk(payload ?? undefined, acc);

  let bodyRaw: string;
  if (acc.plain.length > 0) bodyRaw = acc.plain.join('\n\n');
  else if (acc.html.length > 0) bodyRaw = acc.html.map(htmlToText).join('\n\n');
  else bodyRaw = message.snippet ? decodeEntities(message.snippet) : '';

  let body = collapseWhitespace(bodyRaw);
  if (body.length > options.bodyMaxChars) body = body.slice(0, options.bodyMaxChars);

  return {
    id: message.id ?? '',
    from: headerValue(headers, 'From'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    body,
    attachmentNames: Array.from(new Set(acc.attachments)),
  };
}
