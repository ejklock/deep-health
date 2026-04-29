/**
 * PHP Docker image profiles for Phase 1 (stock images only).
 *
 * Phase 1 uses official php:<version>-cli images for composer execution.
 * Phase 2 (not implemented here) will add on-demand local Docker builds
 * with framework extension profiles (laravel/symfony/wordpress).
 */

/**
 * Default Docker image used when no specific PHP version is configured or inferred.
 * Uses the official composer image which bundles PHP + composer pre-installed.
 */
export const COMPOSER_DEFAULT_IMAGE = 'composer:2';

/**
 * PHP CLI image prefix used when resolving a versioned image.
 * e.g. 'php:8.2-cli'
 */
export const PHP_CLI_IMAGE_PREFIX = 'php';
export const PHP_CLI_IMAGE_SUFFIX = 'cli';

/**
 * Supported PHP framework profile identifiers.
 *
 * - 'none': no framework-specific extensions (stock php-cli image, Phase 1 default).
 * - 'laravel': Laravel framework (requires bcmath, pdo, pdo_mysql, mbstring, etc.).
 * - 'symfony': Symfony framework (requires intl, pdo, zip, etc.).
 * - 'wordpress': WordPress (requires mysqli, gd, zip, etc.).
 */
export type FrameworkProfileId = 'none' | 'laravel' | 'symfony' | 'wordpress';

/**
 * PHP extension lists per framework profile.
 * These are informational in Phase 1 — no extensions are installed; a stock
 * php-cli image is used regardless of framework_profile.
 */
export const PHP_FRAMEWORK_PROFILES: Record<FrameworkProfileId, string[]> = {
  none: [],
  laravel: [
    'bcmath',
    'ctype',
    'fileinfo',
    'json',
    'mbstring',
    'openssl',
    'pdo',
    'pdo_mysql',
    'tokenizer',
    'xml',
    'zip',
  ],
  symfony: [
    'intl',
    'json',
    'mbstring',
    'openssl',
    'pdo',
    'pdo_mysql',
    'tokenizer',
    'xml',
    'zip',
  ],
  wordpress: [
    'gd',
    'json',
    'mbstring',
    'mysqli',
    'openssl',
    'xml',
    'zip',
  ],
};
