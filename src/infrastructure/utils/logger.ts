import chalk from 'chalk';
import { badge, divider, tag } from './ui';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';
let progressSink: ((message: string) => void) | null = null;
let jsonMode = false;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setProgressSink(fn: ((message: string) => void) | null): void {
  progressSink = fn;
}

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function emitJson(level: LogLevel, message: string): void {
  process.stderr.write(
    JSON.stringify({ level, ts: new Date().toISOString(), msg: message }) + '\n',
  );
}

function format(level: LogLevel, message: string): string {
  const prefix: Record<LogLevel, string> = {
    debug: '[DEBUG]',
    info: '[INFO] ',
    warn: '[WARN] ',
    error: '[ERROR]',
  };
  const ts = level === 'debug' ? `${new Date().toISOString()} ` : '';
  return `${prefix[level]} ${ts}${message}`;
}

export const logger = {
  debug(message: string): void {
    if (!shouldLog('debug')) return;
    if (jsonMode) {
      emitJson('debug', message);
    } else {
      process.stderr.write(format('debug', message) + '\n');
    }
  },
  info(message: string): void {
    if (!shouldLog('info')) return;
    if (jsonMode) {
      emitJson('info', message);
      return;
    }
    if (progressSink !== null) {
      progressSink(message);
    } else {
      process.stderr.write(format('info', message) + '\n');
    }
  },
  warn(message: string): void {
    if (!shouldLog('warn')) return;
    if (jsonMode) {
      emitJson('warn', message);
    } else {
      process.stderr.write(format('warn', message) + '\n');
    }
  },
  error(message: string): void {
    if (!shouldLog('error')) return;
    if (jsonMode) {
      emitJson('error', message);
    } else {
      process.stderr.write(format('error', message) + '\n');
    }
  },

  /** Renders a colored phase divider to stderr. */
  phase(id: string): void {
    process.stderr.write(divider(id) + '\n');
  },

  /** Renders a dimmed skip message to stderr. */
  skip(message: string): void {
    process.stderr.write(chalk.dim(`  ${message}`) + '\n');
  },

  /** Renders a badge + label header line to stderr. */
  header(id: string, label: string): void {
    process.stderr.write(`${badge(id)} ${label}\n`);
  },

  /**
   * Emits a tagged log line: `${badge(id)} [${label}] ${message}`.
   * The `[<label>]` substring is preserved verbatim so existing string assertions
   * remain intact. Defaults to 'info' level (honors progressSink).
   */
  tagged(id: string, label: string, message: string, level: LogLevel = 'info'): void {
    const text = `${tag(id, label)} ${message}`;
    logger[level](text);
  },
};

/** Returns a sink function that writes indented progress lines to stderr. */
export function makeProgressSink(indent = '  '): (msg: string) => void {
  return (msg: string) => process.stderr.write(`${indent}${msg}\n`);
}
