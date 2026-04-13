export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
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
    if (shouldLog('info')) process.stderr.write(format('info', message) + '\n');
  },
  warn(message: string): void {
    if (shouldLog('warn')) process.stderr.write(format('warn', message) + '\n');
  },
  error(message: string): void {
    if (shouldLog('error')) process.stderr.write(format('error', message) + '\n');
  },
};
