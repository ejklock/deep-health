import { COMPOSER_DEFAULT_IMAGE } from './php-profiles';

// Bootstrap command injected when the resolved image is a bare `php:*-cli` image
// (which does not bundle composer, git, or unzip). Ensures git/unzip/ca-certificates
// are present (Composer needs unzip to extract dist downloads and git to fetch
// `dev-*` branches), then downloads and installs composer into the container's PATH.
// The `command -v` guard skips the apt-get hit when the image already has them.
// Official installer: https://getcomposer.org/download/
export const COMPOSER_BOOTSTRAP =
  `(command -v git >/dev/null && command -v unzip >/dev/null) ` +
  `|| (apt-get update -qq && apt-get install -y --no-install-recommends git unzip ca-certificates) ` +
  `&& php -r "copy('https://getcomposer.org/installer','/tmp/cs.php');" ` +
  `&& php /tmp/cs.php --quiet --install-dir=/usr/local/bin --filename=composer ` +
  `&& rm -f /tmp/cs.php`;

/**
 * Returns true when `image` is a bare `php:*-cli` image that does not bundle
 * composer. Used by the composer plugin's `runtimeSpec` preamble to decide
 * whether to inject COMPOSER_BOOTSTRAP before each command.
 */
export function isPhpCliImage(image: string): boolean {
  return /^php:\d/.test(image) && image.endsWith('-cli');
}

// Re-export COMPOSER_DEFAULT_IMAGE so existing imports from this module still work.
export { COMPOSER_DEFAULT_IMAGE };
