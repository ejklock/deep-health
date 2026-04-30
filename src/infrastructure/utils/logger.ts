import chalk from 'chalk';
import { badge, divider } from './ui';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';
let progressSink: ((message: string) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setProgressSink(fn: ((message: string) => void) | null): void {
  progressSink = fn;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function format(level: LogLevel, message: string): string {
  const prefix: Record<LogLevel, string> = {
    debug: '[DEBUG]',
    info: '[INFO] ',
    warn: '[WARN] ',
    error: '[ERROR]',
  };
  return `${prefix[level]} ${message}`;
}

export const logger = {
  debug(message: string): void {
    if (shouldLog('debug')) process.stderr.write(format('debug', message) + '\n');
  },
  info(message: string): void {
    if (!shouldLog('info')) return;
    if (progressSink !== null) {
      progressSink(message);
    } else {
      process.stderr.write(format('info', message) + '\n');
    }
  },
  warn(message: string): void {
    if (shouldLog('warn')) process.stderr.write(format('warn', message) + '\n');
  },
  error(message: string): void {
    if (shouldLog('error')) process.stderr.write(format('error', message) + '\n');
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
};

/** Returns a sink function that writes indented progress lines to stderr. */
export function makeProgressSink(indent = '  '): (msg: string) => void {
  return (msg: string) => process.stderr.write(`${indent}${msg}\n`);
}
