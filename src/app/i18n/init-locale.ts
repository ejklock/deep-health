import type { SupportedLocale } from '@core/types/locale';
import { en } from '@app/i18n/locales/en';
import { ptBr } from '@app/i18n/locales/pt-br';

/**
 * All user-facing strings used by the init command.
 *
 * Static strings are plain string properties.
 * Dynamic strings (requiring interpolation) are functions.
 */
export interface InitLocale {
  // ── Language prompt (bilingual — used before locale is resolved) ─────────────
  /** 'Language / Idioma' */
  languagePrompt: string;
  languageChoiceEn: string;
  languageChoicePtBr: string;

  // ── Project / client ─────────────────────────────────────────────────────────
  projectNamePrompt: string;
  clientNamePrompt: string;

  // ── Ecosystem selection ───────────────────────────────────────────────────────
  ecosystemSelectPrompt: string;

  // ── Per-ecosystem fixer ───────────────────────────────────────────────────────
  fixerStrategyPrompt: (pluginName: string) => string;

  // ── Per-ecosystem validation commands ────────────────────────────────────────
  includeValidationCommandPrompt: (pluginName: string, cmdName: string) => string;
  validationCommandValuePrompt: (pluginName: string, cmdName: string) => string;

  // ── Per-ecosystem advisors ────────────────────────────────────────────────────
  includeAdvisorPrompt: (pluginName: string, advisorName: string) => string;
  advisorCommandPrompt: (pluginName: string, advisorName: string) => string;

  // ── Version prompts ───────────────────────────────────────────────────────────
  languageVersionPromptWithInferred: (pluginName: string, inferred: string) => string;
  languageVersionPromptBlank: (pluginName: string) => string;
  phpVersionPromptWithInferred: (pluginName: string, inferred: string) => string;
  phpVersionPromptBlank: (pluginName: string) => string;
  pythonVersionPromptWithInferred: (pluginName: string, inferred: string) => string;
  pythonVersionPromptBlank: (pluginName: string) => string;

  // ── Image source ──────────────────────────────────────────────────────────────
  imageSourcePrompt: (pluginName: string) => string;
  imageSourcePull: string;
  imageSourceDockerfile: string;
  dockerfilePathPrompt: (pluginName: string) => string;
  buildContextPrompt: (pluginName: string) => string;
  buildArgsPrompt: (pluginName: string) => string;

  // ── SonarQube ─────────────────────────────────────────────────────────────────
  enableSonarQubePrompt: string;
  sonarQubeModePrompt: string;
  sonarQubeModeManaged: string;
  sonarQubeModeExternal: string;

  // ── Reports / output ─────────────────────────────────────────────────────────
  generateMarkdownPrompt: string;
  reportsOutputDirPrompt: string;

  // ── Post-creation messages ────────────────────────────────────────────────────
  createdFile: (path: string) => string;
  foundExistingSonarProps: string;
  nextStepsHeader: string;
  nextStepEditConfig: (path: string) => string;
  nextStepReviewProtectedPackages: string;
  nextStepReviewSonarProps: string;
  /** Step 4 when sonarPropsCreated is true */
  nextStepRunScanStep4: (cliName: string) => string;
  /** Step 3 when sonarPropsCreated is false */
  nextStepRunScanStep3: (cliName: string) => string;
  nextStepConfigNote: string;
}

const localeMap: Record<SupportedLocale, InitLocale> = {
  en,
  'pt-br': ptBr,
};

export function getInitLocale(code: SupportedLocale): InitLocale {
  return localeMap[code];
}
