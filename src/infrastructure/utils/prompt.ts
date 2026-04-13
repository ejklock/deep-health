import { createInterface } from 'node:readline/promises';

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` (default: ${defaultValue})` : '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}${hint}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

export async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N]: `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
