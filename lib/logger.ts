/**
 * Minimal structured JSON logger over console.
 * Each line is a single JSON object so Vercel's log viewer can filter on fields.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(base: LogFields): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Serialise unknown values (Error instances included) into plain JSON. */
export function serialiseError(err: unknown): LogFields {
  if (err instanceof Error) {
    const out: LogFields = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    const extra = err as unknown as Record<string, unknown>;
    for (const key of ['status', 'code', 'retryAfterSeconds', 'model']) {
      if (extra[key] !== undefined) out[key] = extra[key];
    }
    return out;
  }
  return { message: String(err) };
}

export function createLogger(sink: LogSink = defaultSink, base: LogFields = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    const record: LogFields = { level, time: new Date().toISOString(), msg, ...base, ...fields };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, time: record.time, msg, serialisationError: true });
    }
    sink(level, line);
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childBase) => createLogger(sink, { ...base, ...childBase }),
  };
}

/** Logger that discards everything; handy in tests. */
export const silentLogger: Logger = createLogger(() => {});

export const logger: Logger = createLogger();
