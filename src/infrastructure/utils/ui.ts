import chalk, { type ChalkInstance } from 'chalk';

// ─── Scanner color palette ────────────────────────────────────────────────────

export const SCANNER_COLORS: Map<string, ChalkInstance> = new Map([
  ['osv', chalk.hex('#F97316')],
  ['sonarqube', chalk.hex('#4D9FE8')],
  ['npm', chalk.hex('#22C55E')],
  ['composer', chalk.hex('#8B5CF6')],
  ['pip', chalk.hex('#F59E0B')],
]);

function scannerColor(id: string): ChalkInstance {
  return SCANNER_COLORS.get(id) ?? chalk.bold.white;
}

// ─── Badge ────────────────────────────────────────────────────────────────────

export function badge(id: string): string {
  return scannerColor(id)(`[${id.toUpperCase()}]`);
}

// ─── Divider ──────────────────────────────────────────────────────────────────

const DIVIDER_WIDTH = 60;
const DIVIDER_CHAR = '─';

export function divider(label?: string): string {
  const color = label !== undefined && SCANNER_COLORS.has(label)
    ? scannerColor(label)
    : chalk.gray;

  if (label === undefined || label === '') {
    return color(DIVIDER_CHAR.repeat(DIVIDER_WIDTH));
  }

  const inner = ` ${label.toUpperCase()} `;
  const remaining = Math.max(0, DIVIDER_WIDTH - inner.length);
  const leftCount = Math.floor(remaining / 2);
  const rightCount = remaining - leftCount;

  return color(
    `${DIVIDER_CHAR.repeat(leftCount)}${inner}${DIVIDER_CHAR.repeat(rightCount)}`,
  );
}

// ─── Semantic chalk shortcuts ─────────────────────────────────────────────────

export const dim = chalk.dim;
export const success = chalk.hex('#22C55E').bold;
export const warn = chalk.hex('#F59E0B').bold;
export const error = chalk.hex('#EF4444').bold;
