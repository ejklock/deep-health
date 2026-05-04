/**
 * Brand constants for the CLI.
 *
 * All values are evaluated at module load time.  For compiled Bun binaries,
 * `--define 'process.env.CLI_NAME="<name>"'` bakes the value in at build time.
 * For Node.js execution (dev / test), values fall back to the `deep-health` defaults.
 */

/** The CLI binary name (e.g. 'deep-health' or 'security-scan'). Controls all user-visible references. */
export const CLI_NAME: string = process.env['CLI_NAME'] ?? 'deep-health';

/** Default sub-directory for report files relative to the project root. */
export const DEFAULT_REPORTS_SUBDIR: string = `.${CLI_NAME}/reports`;

/** Default sub-directory for audit trail files relative to the project root. */
export const DEFAULT_AUDIT_SUBDIR: string = `.${CLI_NAME}`;

/** Default git branch name prefix for fix branches. */
export const DEFAULT_BRANCH_PREFIX: string = `fix/${CLI_NAME}-`;

/** Default dotfile name for the sanitized SonarQube properties copy inside cwd. */
export const DEFAULT_SONAR_DOTFILE: string = `.${CLI_NAME}-sonar-project.properties`;

/** Default prefix for the OS temp directory used for sanitized SonarQube properties. */
export const DEFAULT_SONAR_TEMPDIR_PREFIX: string = `${CLI_NAME}-sonar-`;

/** Google Drive config directory name (relative to $XDG_CONFIG_HOME / ~/.config). */
export const DEFAULT_GDRIVE_CONFIG_DIR: string = CLI_NAME;

/**
 * Environment variable name that activates the kill-switch (skip all automated fixes).
 * Example: CLI_NAME='deep-health' → 'DEEP_HEALTH_NO_AUTO_FIX'
 *          CLI_NAME='security-scan' → 'SECURITY_SCAN_NO_AUTO_FIX'
 */
export const KILL_SWITCH_VAR: string =
  `${CLI_NAME.toUpperCase().replace(/-/g, '_')}_NO_AUTO_FIX`;

/**
 * Default npm fixer strategy.
 * Overridable via NPM_DEFAULT_FIXER env var or --define at Bun compile time.
 * Valid values: 'osv' | 'npm-audit' | 'osv-then-audit'
 */
export const NPM_DEFAULT_FIXER: string = process.env['NPM_DEFAULT_FIXER'] ?? 'osv-then-audit';
