/**
 * Neutral locale type — decoupled from report/i18n internals.
 * Consumers (config, report options, etc.) should import from here
 * rather than from the report/i18n package to avoid a cross-layer dependency.
 */
export type SupportedLocale = 'pt-br' | 'en';
