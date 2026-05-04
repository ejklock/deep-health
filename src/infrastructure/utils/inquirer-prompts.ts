import { confirm, select, checkbox, input } from '@inquirer/prompts';

/**
 * Thin wrappers around @inquirer/prompts. Exported as a dedicated module so
 * tests can mock the entire seam via vi.mock('@infra/utils/inquirer-prompts')
 * without needing to mock the upstream package directly.
 */

export async function confirmPrompt(message: string, defaultValue = false): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

export async function selectPrompt<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T }>,
  defaultValue?: T,
): Promise<T> {
  return select<T>({ message, choices, default: defaultValue });
}

export async function checkboxPrompt<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T; checked?: boolean }>,
): Promise<T[]> {
  return checkbox<T>({ message, choices });
}

export async function inputPrompt(message: string, defaultValue?: string): Promise<string> {
  return input({ message, default: defaultValue });
}
