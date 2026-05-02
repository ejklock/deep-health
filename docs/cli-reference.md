# CLI Reference — deep-health

## Overview

```
deep-health <command> [options]
```

All commands require Node ≥ 22 and Docker. See [ADR-0001](./adr/0001-docker-only-runtime.md) for why Docker is required — no local mode is supported for ecosystem CLIs.

---

## Commands

### `init`

Generates a `project-config.yml` starter template in the current directory.

```bash
deep-health init [options]

Options:
  --project-name <name>   Project name written into config
  --client <name>         Client name written into config
  --output <path>         Output path (default: ./project-config.yml)
  --force                 Overwrite if the file already exists
```

**What it does:**

1. Detects the runtime environment (PHP version from `composer.json`, Node version from `.nvmrc` / `package.json`, Python version from `runtime.txt` / `.python-version`).
2. Renders a `project-config.yml` from the built-in Handlebars template (`infrastructure/config/templates/project-config.hbs.ts`).
3. Writes to the output path. Fails if the file exists and `--force` is not set.

**Exit codes:** `0` success, `3` config/output error.

---

### `scan`

Runs the vulnerability scan only. No files are modified.

```bash
deep-health scan [options]

Options:
  -c, --config <path>   Path to project-config.yml (default: ./project-config.yml)
  --cwd <path>          Working directory (default: current directory)
  --dry-run             Print what would run, execute nothing
  -v, --verbose         Enable verbose output
  -q, --quiet           Suppress all output except errors and final report
  --json                Output results as JSON to stdout
  -o, --output <path>   Write output to file instead of stdout
```

**What it does:**

1. Loads `project-config.yml` and validates with Zod schema.
2. Calls `runScanner()` which runs `osv-scanner` in an ephemeral Docker container against detected lockfiles.
3. Formats and emits the result (text summary or JSON).

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | No vulnerabilities found |
| `1` | Breaking vulnerabilities found |
| `2` | Scanner error (gate failure or OSV error) |
| `3` | Configuration error |

---

### `fix`

Full workflow: scan → apply safe updates per ecosystem → generate executive report.

```bash
deep-health fix [options]

Options:
  -c, --config <path>             Path to project-config.yml
  --phases <phases>               Comma-separated phases to run.
                                  Accepted values: scan, npm, composer, pip, report
                                  Default: all phases
  --no-report                     Skip executive report generation
  --authorize-breaking <id...>    Allow breaking-change updates for these ecosystems.
                                  Repeatable: --authorize-breaking npm --authorize-breaking composer
  --dry-run                       Log planned changes, execute nothing
  -v, --verbose                   Enable verbose output
  --json                          Output results as JSON
  -o, --output <path>             Write report to file
```

**What it does:**

See the [Orchestrator Pipeline Flow](./architecture.md#orchestrator-pipeline-flow) diagram. In short:

1. Loads config and validates.
2. Runs all scanner engines (OSV primary + SonarQube secondary if configured).
3. Runs Gate A validation on the OSV result.
4. For each registered ecosystem plugin (in registration order):
   a. Runs advisors (informational only — never blocks).
   b. Skips the plugin if there are no `auto_safe` vulnerabilities (or no `breaking` vulns when `--authorize-breaking` was given).
   c. Resolves the Docker container runner (npm/pip/composer).
   d. For npm, auto-demotes `osv`/`osv-then-audit` to `npm-audit` if `package-lock.json` has `lockfileVersion: 1` (osv-scanner cannot patch v1 lockfiles in-place). Applies OSV staging-fix if the effective strategy is `osv` or `osv-then-audit`.
   e. Calls `plugin.runUpdater()`.
   f. Optionally installs breaking packages (`--authorize-breaking`).
   g. Runs post-update OSV residual verification.
   h. Validates update result against ecosystem gate (Zod schema).
5. Generates and saves the executive report (HTML + optionally Markdown).
6. Writes `.deep-health-audit.json` audit trail.

**Environment variable kill-switch:**

```bash
DEEP_HEALTH_NO_AUTO_FIX=1 deep-health fix
```

Skips all automated fixes after the scan phase. Useful in CI pipelines where you want the scan result without any file mutations.

**Breaking-change authorization:**

```bash
deep-health fix --authorize-breaking composer npm
```

Breaking packages (`classification: 'breaking'`) are skipped unless their ecosystem is explicitly authorized. Authorization is per-run and never persisted.

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | All resolved (or nothing to fix) |
| `1` | Vulnerabilities found / update errors / pending vulns remain |
| `2` | Gate validation failure or scanner error |
| `3` | Configuration error |

---

### `executive-report`

Generates an executive HTML report from the last scan results stored on disk.

```bash
deep-health executive-report [options]

Options:
  --client <name>     Client name (overrides project-config.yml)
  --project <name>    Project name (overrides project-config.yml)
  -o, --output <path> Write report to file
```

**What it does:**

Reads the most recent scan JSON outputs from the reports directory and renders the executive HTML template via Handlebars. Supports `en` and `pt-br` locales (set via `report_language` in config).

---

### `cloud-setup`

Interactive Google Drive folder picker. Saves the chosen folder ID to `project-config.yml`.

```bash
deep-health cloud-setup
```

**What it does:**

1. Initiates Google OAuth flow (opens browser via `execFile` with `shell: false` — no shell injection possible).
2. Lists your Google Drive folders interactively.
3. Writes the selected folder ID to `cloud_storage.google_drive.folder_id` in `project-config.yml`.

Once configured, `deep-health fix` automatically uploads the executive report to that Drive folder after each run.

---

## Configuration Reference

Full annotated `project-config.yml`:

```yaml
project:
  name: 'My Project'
  client: 'Acme Corp'

report_language: 'en'       # 'en' | 'pt-br'

runtime:
  php: '8.1'
  python: '3.11'            # required when using pip ecosystem
  node: '20.x'
  package_manager_php: 'composer'
  package_manager_js: 'npm'
  package_manager_python: 'pip'   # pip | pipenv | poetry
  execution: 'docker'             # docker | local
  docker_service: 'app'           # docker-compose service name
  test_command: 'php artisan test --compact'
  build_commands:
    frontend: 'npm run build'
    backend: 'npm run build:backend'

# Packages that must never be updated beyond their stated constraint.
protected_packages:
  composer:
    - package: 'laravel/framework'
      constraint: '^10.8'
      reason: 'Major upgrade to Laravel 11 requires a dedicated project'
  npm:
    - package: 'tailwindcss'
      constraint: '^3.3.3'
      reason: 'Tailwind v4 has breaking config changes'
  pip:
    - package: 'django'
      constraint: '>=4.2,<5.0'
      reason: 'Django 5.x has breaking changes'

safe_update_policy:
  allow_patch_and_minor_within_constraints: true
  require_authorization_for_constraint_change: true

# Per-ecosystem configuration
ecosystems:
  - id: npm
    fixer: 'osv-then-audit'   # osv | npm-audit | osv-then-audit
    validationCommands:
      - name: 'Tests'
        command: 'npm test'
        on_failure: 'revert'  # revert | warn | fail
  - id: composer
    fixer: 'osv'
  - id: pip
    fixer: 'osv'

# Scanner settings
scanners:
  osv:
    runner: 'docker'          # docker | local (separate seam — see ADR-0001)
    image: 'ghcr.io/google/osv-scanner:latest'   # optional override
  sonarqube:
    enabled: false            # set true to run SonarQube scan
    on_failure: 'warn'        # warn | fail

# Runner settings (ecosystem container configuration)
runners:
  npm:
    language_version: '20'    # optional; inferred from .nvmrc / package.json#engines.node
    # image: 'node:20'        # optional explicit override; resolved from language_version otherwise
    # native_deps:            # OS packages to apt-get install before npm ci runs
    #   - libvips-dev         # required by sharp@0.x on glibc 2.28 images (e.g. node:14)
    #   - build-essential     # required by any native addon that uses node-gyp
    #   - python3             # required by node-gyp on some distros
  composer:
    language_version: '8.1'   # optional; inferred from composer.json#require.php
    # native_deps:            # OS packages required by PHP extensions
    #   - imagemagick
    #   - libmagickwand-dev
  pip:
    language_version: '3.11'  # optional; inferred from runtime.txt / .python-version
    # native_deps:            # OS packages required by C-extension pip packages
    #   - libjpeg-dev         # Pillow
    #   - libpq-dev           # psycopg2

# Output settings
outputs:
  dir: './reports'
  sub_folders: false
  formats:
    - 'markdown'              # HTML is always generated; markdown is opt-in

# Cloud storage (optional)
cloud_storage:
  provider: 'google_drive'
  google_drive:
    folder_id: 'YOUR_FOLDER_ID'
  require_upload: false       # if true, fix exits 1 when upload fails
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Clean — no vulnerabilities or all resolved |
| `1` | Vulnerabilities found, update errors, or pending vulns after fix |
| `2` | Gate validation failure or scanner error |
| `3` | Configuration error |

These codes make `deep-health` suitable for CI/CD pipelines. A non-zero exit from `scan` or `fix` will fail the pipeline step.

---

## CI/CD Example

```yaml
# .github/workflows/security.yml
name: Security scan

on:
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6am
  push:
    paths:
      - 'composer.lock'
      - 'package-lock.json'
      - 'requirements.txt'

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install -g deep-health
      - run: deep-health scan --json --output scan-results.json
      - uses: actions/upload-artifact@v4
        with:
          name: scan-results
          path: scan-results.json
```

---

## Environment Variables

| Variable | Effect |
|---|---|
| `DEEP_HEALTH_NO_AUTO_FIX=1` | Skips all automated fixes after the scan phase |
| `LOG_LEVEL=debug` | Enables debug-level logging |
