/**
 * Tests for src/infrastructure/utils/prompt.ts
 * Mocks readline/promises to avoid stdin interaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

import { prompt } from '@infra/utils/prompt';

describe('prompt()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClose.mockReturnValue(undefined);
  });

  it('returns trimmed answer when user provides input', async () => {
    mockQuestion.mockResolvedValue('  my-answer  ');
    const result = await prompt('Enter something');
    expect(result).toBe('my-answer');
  });

  it('returns default value when answer is empty and default is provided', async () => {
    mockQuestion.mockResolvedValue('');
    const result = await prompt('Enter something', 'default-val');
    expect(result).toBe('default-val');
  });

  it('includes default hint in the question string when defaultValue is provided', async () => {
    mockQuestion.mockResolvedValue('');
    await prompt('Enter something', 'my-default');
    expect(mockQuestion).toHaveBeenCalledWith('Enter something (default: my-default): ');
  });

  it('does not include default hint when no defaultValue', async () => {
    mockQuestion.mockResolvedValue('hello');
    await prompt('Enter something');
    expect(mockQuestion).toHaveBeenCalledWith('Enter something: ');
  });

  it('returns empty string when answer is empty and no default', async () => {
    mockQuestion.mockResolvedValue('  ');
    const result = await prompt('Enter something');
    expect(result).toBe('');
  });

  it('calls rl.close() in finally block', async () => {
    mockQuestion.mockResolvedValue('answer');
    await prompt('Q?');
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('calls rl.close() even when question rejects', async () => {
    mockQuestion.mockRejectedValue(new Error('stdin closed'));
    await expect(prompt('Q?')).rejects.toThrow('stdin closed');
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
