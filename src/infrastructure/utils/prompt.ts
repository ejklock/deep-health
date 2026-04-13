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
