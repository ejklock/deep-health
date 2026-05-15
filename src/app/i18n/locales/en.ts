import type { InitLocale } from '@app/i18n/init-locale';

export const en: InitLocale = {
  // ── Language prompt ───────────────────────────────────────────────────────────
  languagePrompt: 'Language / Idioma',
  languageChoiceEn: 'English (en)',
  languageChoicePtBr: 'Português (pt-br)',

  // ── Project / client ─────────────────────────────────────────────────────────
  projectNamePrompt: 'Project name',
  clientNamePrompt: 'Client name',

  // ── Ecosystem selection ───────────────────────────────────────────────────────
  ecosystemSelectPrompt: 'Select ecosystems to configure (Space to toggle, Enter to confirm)',

  // ── Per-ecosystem fixer ───────────────────────────────────────────────────────
  fixerStrategyPrompt: (pluginName) => `  [${pluginName}] Fixer strategy`,

  // ── Per-ecosystem validation commands ────────────────────────────────────────
  includeValidationCommandPrompt: (pluginName, cmdName) =>
    `  [${pluginName}] Include "${cmdName}" validation command?`,
  validationCommandValuePrompt: (pluginName, cmdName) =>
    `  [${pluginName}] Validation command "${cmdName}"`,

  // ── Per-ecosystem advisors ────────────────────────────────────────────────────
  includeAdvisorPrompt: (pluginName, advisorName) =>
    `  [${pluginName}] Include "${advisorName}" advisor?`,
  advisorCommandPrompt: (pluginName, advisorName) =>
    `  [${pluginName}] Advisor "${advisorName}" command`,

  // ── Version prompts ───────────────────────────────────────────────────────────
  languageVersionPromptWithInferred: (pluginName, inferred) =>
    `  [${pluginName}] Language version (inferred: ${inferred}, blank to use detected)`,
  languageVersionPromptBlank: (pluginName) =>
    `  [${pluginName}] Language version (blank to skip)`,
  phpVersionPromptWithInferred: (pluginName, inferred) =>
    `  [${pluginName}] PHP language version (inferred: ${inferred}, blank to use detected)`,
  phpVersionPromptBlank: (pluginName) =>
    `  [${pluginName}] PHP language version (blank to skip)`,
  pythonVersionPromptWithInferred: (pluginName, inferred) =>
    `  [${pluginName}] Python language version (inferred: ${inferred}, blank to use detected)`,
  pythonVersionPromptBlank: (pluginName) =>
    `  [${pluginName}] Python language version (blank to skip)`,

  // ── Image source ──────────────────────────────────────────────────────────────
  imageSourcePrompt: (pluginName) => `  [${pluginName}] Image source`,
  imageSourcePull:
    'pull — uses a standard registry image (may lack project-specific extensions or tools)',
  imageSourceDockerfile:
    'dockerfile (recommended) — builds from your project Dockerfile with all extensions and tools pre-installed',
  dockerfilePathPrompt: (pluginName) => `  [${pluginName}] Dockerfile path`,
  buildContextPrompt: (pluginName) => `  [${pluginName}] Build context (blank for '.')`,
  buildArgsPrompt: (pluginName) =>
    `  [${pluginName}] Build args (KEY=VALUE comma-separated, blank to skip)`,

  // ── SonarQube ─────────────────────────────────────────────────────────────────
  enableSonarQubePrompt: 'Enable SonarQube scanner?',
  sonarQubeModePrompt: 'SonarQube mode',
  sonarQubeModeManaged:
    'Managed (recommended) — provisions an ephemeral SonarQube container via Docker, no server setup needed',
  sonarQubeModeExternal:
    'External — connects to an existing SonarQube server (better performance, no container overhead per scan)',

  // ── Reports / output ─────────────────────────────────────────────────────────
  generateMarkdownPrompt: 'Generate markdown reports?',
  reportsOutputDirPrompt: 'Reports output directory',

  // ── Post-creation messages ────────────────────────────────────────────────────
  createdFile: (path) => `Created: ${path}\n`,
  foundExistingSonarProps: 'Found existing sonar-project.properties (not overwritten)\n',
  nextStepsHeader: '\nNext steps:\n',
  nextStepEditConfig: (path) => `  1. Edit ${path} to match your project\n`,
  nextStepReviewProtectedPackages:
    '  2. Review protected_packages — add any packages that must not be auto-upgraded\n',
  nextStepReviewSonarProps:
    '  3. Review sonar-project.properties — adjust sonar.sources and sonar.exclusions for your layout\n',
  nextStepRunScanStep4: (cliName) => `  4. Run: ${cliName} scan --cwd <your-project-dir>\n`,
  nextStepRunScanStep3: (cliName) => `  3. Run: ${cliName} scan --cwd <your-project-dir>\n`,
  nextStepConfigNote:
    '     (config will be loaded from project-config.yml at project root by default)\n',
};
