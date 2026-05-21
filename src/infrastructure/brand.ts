/**
 * Brand constants for the CLI.
 *
 * Hardcoded to 'security-scan'. No whitelabel support.
 */

/** The CLI binary name. */
export const CLI_NAME = 'security-scan';

/** Default sub-directory for report files relative to the project root. */
export const DEFAULT_REPORTS_SUBDIR = `.${CLI_NAME}/reports`;

/** Default sub-directory for audit trail files relative to the project root. */
export const DEFAULT_AUDIT_SUBDIR = `.${CLI_NAME}`;

/** Default git branch name prefix for fix branches. */
export const DEFAULT_BRANCH_PREFIX = `fix/${CLI_NAME}-`;

/** Default dotfile name for the sanitized SonarQube properties copy inside cwd. */
export const DEFAULT_SONAR_DOTFILE = `.${CLI_NAME}-sonar-project.properties`;

/** Default prefix for the OS temp directory used for sanitized SonarQube properties. */
export const DEFAULT_SONAR_TEMPDIR_PREFIX = `${CLI_NAME}-sonar-`;

/** Google Drive config directory name (relative to $XDG_CONFIG_HOME / ~/.config). */
export const DEFAULT_GDRIVE_CONFIG_DIR = CLI_NAME;

/**
 * Environment variable name that activates the kill-switch (skip all automated fixes).
 * 'SECURITY_SCAN_NO_AUTO_FIX'
 */
export const KILL_SWITCH_VAR = 'SECURITY_SCAN_NO_AUTO_FIX';

/**
 * Default npm fixer strategy.
 * Valid values: 'osv' | 'npm-audit' | 'osv-then-audit'
 */
export const NPM_DEFAULT_FIXER = 'osv-then-audit';
