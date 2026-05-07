# deep-health — Complete Usage Guide

> Version 0.1.3 | Node.js ≥ 26 | Docker required

---

## Table of Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Quick Start](#quick-start)
5. [Commands](#commands)
   - [init](#init)
   - [scan](#scan)
   - [fix](#fix)
   - [executive-report](#executive-report)
   - [cloud-setup](#cloud-setup)
6. [Configuration Reference](#configuration-reference)
   - [project](#project)
   - [report_language](#report_language)
   - [ecosystems](#ecosystems)
   - [protected_packages](#protected_packages)
   - [safe_update_policy](#safe_update_policy)
   - [conflict_resolution](#conflict_resolution)
   - [scanners](#scanners)
   - [runners](#runners)
   - [scan (scan paths)](#scan-scan-paths)
   - [outputs](#outputs)
   - [cloud_storage](#cloud_storage)
   - [workflow](#workflow)
7. [Docker and Runtime Strategies](#docker-and-runtime-strategies)
   - [Image Source: pull vs dockerfile](#image-source-pull-vs-dockerfile)
   - [Runtime Version Resolution](#runtime-version-resolution)
   - [Native OS Dependencies](#native-os-dependencies)
8. [Scanner Engines](#scanner-engines)
   - [OSV Scanner](#osv-scanner)
   - [SonarQube](#sonarqube)
9. [Ecosystem Plugins and Fixer Strategies](#ecosystem-plugins-and-fixer-strategies)
   - [npm](#npm)
   - [composer](#composer)
   - [pip](#pip)
   - [Fixer Strategies](#fixer-strategies)
10. [Protected Packages and Safe Update Policy](#protected-packages-and-safe-update-policy)
11. [Git Branch and PR Workflow](#git-branch-and-pr-workflow)
12. [CI/CD Integration](#cicd-integration)
13. [Environment Variables](#environment-variables)
14. [Exit Codes](#exit-codes)
15. [Troubleshooting](#troubleshooting)
16. [FAQ](#faq)

---

## Overview

`deep-health` is a CLI tool that automates the full vulnerability management workflow for multi-ecosystem projects. In a single command it can:

1. Scan all lockfiles (`composer.lock`, `package-lock.json`, `requirements.txt`, `Pipfile.lock`) using [OSV Scanner](https://google.github.io/osv-scanner/)
2. Classify vulnerabilities as safe-to-update or requiring manual authorization
3. Apply patch and minor updates inside isolated Docker containers — no local PHP/Node/Python installation needed
4. Run your validation commands (test suites) inside the same container to confirm nothing broke
5. Revert all changes automatically if validation fails
6. Generate an executive HTML report with a before/after vulnerability comparison
7. Upload the report to Google Drive
8. Open a GitHub pull request with the safe changes already validated

Breaking changes (major version bumps, constraint changes) are never applied automatically. They require explicit per-ecosystem authorization via `--authorize-breaking`.

---

## Requirements

| Tool    | Minimum version |
|---------|----------------|
| Node.js | ≥ 26.0.0       |
| Docker  | any recent     |

Docker is the only runtime requirement beyond Node.js. OSV Scanner, SonarQube, npm, PHP Composer, and pip all run inside ephemeral Docker containers. You do not need to install any of those tools locally.

The `gh` CLI is required only if you use `--open-pr`. Install it from [cli.github.com](https://cli.github.com).

---

## Installation

Install globally with npm:

```bash
npm install -g deep-health
```

Verify the installation:

```bash
deep-health --version
# deep-health/0.1.3
```

Run without installing (useful for one-off scans):

```bash
npx deep-health --help
```

---

## Quick Start

**Step 1: Generate a config file**

```bash
deep-health init
```

This starts an interactive wizard that detects your ecosystems (npm, composer, pip), asks you to confirm or adjust the configuration, and writes a `project-config.yml` to the current directory.

**Step 2: Scan for vulnerabilities**

```bash
deep-health scan
```

Prints a summary of all vulnerabilities found. No files are modified.

**Step 3: Apply safe fixes**

```bash
deep-health fix
```

Runs the full pipeline: scan → apply safe updates → validate → revert if broken → generate executive report.

**Step 4: Apply safe fixes and open a PR**

```bash
deep-health fix --open-pr
```

Same as above, plus creates a git branch, commits the changes, pushes, and opens a GitHub pull request.

---

## Commands

### `init`

Generates a `project-config.yml` template for the current project.

```
deep-health init [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--project-name <name>` | string | prompted | Project name written into the config |
| `--client <name>` | string | prompted | Client name written into the config |
| `--cwd <path>` | string | current directory | Working directory for ecosystem detection |
| `--output <path>` | string | `./project-config.yml` | Output file path |
| `--force` | boolean | `false` | Overwrite the file if it already exists |

**What happens during `init`:**

1. Checks if `project-config.yml` already exists (fails unless `--force` is set).
2. Prompts for project name and client name (or uses CLI flags).
3. Detects the runtime environment by reading project files:
   - **npm**: reads `.nvmrc`, `.node-version`, `package.json#engines.node`
   - **composer**: reads `.php-version`, `composer.json#require.php`
   - **pip**: reads `runtime.txt`, `.python-version`
4. Presents an ecosystem selection checkbox (detected ecosystems are pre-checked).
5. For each ecosystem, prompts for:
   - Fixer strategy (`osv`, `npm-audit`, `osv-then-audit`)
   - Validation commands (e.g. `npm test`, `php artisan test`)
   - Advisor commands (e.g. `npm audit --json`)
   - Language/runtime version (inferred or entered manually)
   - Image source (`pull` or `dockerfile`)
6. Asks whether to enable SonarQube integration.
7. Asks for the report language (`en` or `pt-br`).
8. Asks whether to generate Markdown reports and where to save them.
9. Writes the generated `project-config.yml`.
10. If SonarQube is enabled and `sonar-project.properties` does not exist, creates a starter template.

**Example — non-interactive (CI-friendly):**

```bash
deep-health init \
  --project-name "My App" \
  --client "Acme Corp" \
  --force
```

In non-interactive mode (when stdin is not a TTY), `init` auto-selects all detected ecosystems and their default values.

**Exit codes:** `0` success, `3` config/output error.

---

### `scan`

Runs the vulnerability scan only. No files are modified.

```
deep-health scan [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-c, --config <path>` | string | `./project-config.yml` | Path to config file |
| `--cwd <path>` | string | current directory | Working directory (project root) |
| `--dry-run` | boolean | `false` | Print what would run, execute nothing |
| `-v, --verbose` | boolean | `false` | Enable verbose output |
| `-q, --quiet` | boolean | `false` | Suppress all output except errors and the final report |
| `--json` | boolean | `false` | Output results as JSON to stdout |
| `-o, --output <path>` | string | stdout | Write output to a file |

**What happens during `scan`:**

1. Loads and validates `project-config.yml` using the Zod schema. Exits with code `3` on validation error.
2. Runs `osv-scanner` inside an ephemeral Docker container against all detected lockfiles in the working directory.
3. Parses the OSV output and classifies each finding:
   - `auto_safe` — patch/minor update within current constraints
   - `breaking` — major version bump or constraint change required
4. Formats and emits the result (text summary or JSON).

**Examples:**

```bash
# Basic scan
deep-health scan

# Scan a project in a different directory
deep-health scan --cwd /path/to/project

# Save JSON results to a file (useful for CI artifacts)
deep-health scan --json --output scan-results.json

# Quiet mode: only print the final summary
deep-health scan --quiet
```

**Sample output:**

```
deep-health scan summary
========================
npm        2 vulnerabilities  (1 auto-safe, 1 breaking)
composer   0 vulnerabilities
pip        1 vulnerability    (1 auto-safe)

Exit code: 1 (breaking vulnerabilities found)
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | No vulnerabilities found |
| `1` | Breaking vulnerabilities found |
| `2` | Scanner error (gate failure or OSV error) |
| `3` | Configuration error |

---

### `fix`

Full workflow: scan → apply safe updates per ecosystem → validate → revert if broken → generate executive report.

```
deep-health fix [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-c, --config <path>` | string | `./project-config.yml` | Path to config file |
| `--cwd <path>` | string | current directory | Working directory (project root) |
| `--phases <phases>` | string | all phases | Comma-separated list of phases to run. Accepted values: `scan`, `npm`, `composer`, `pip`, `report` |
| `--no-report` | boolean | `false` | Skip executive report generation |
| `--authorize-breaking <id...>` | string[] | none | Authorize breaking-change updates for the given ecosystem(s). Example: `--authorize-breaking composer npm` |
| `--dry-run` | boolean | `false` | Log planned changes, execute nothing |
| `-v, --verbose` | boolean | `false` | Enable verbose output |
| `-q, --quiet` | boolean | `false` | Suppress all output except errors and the final report |
| `--json` | boolean | `false` | Output results as JSON |
| `-o, --output <path>` | string | stdout | Write report to file |
| `--create-branch` | boolean | `false` | Create a git branch before applying fixes and commit changes on success |
| `--branch-prefix <prefix>` | string | `fix/deep-health-` | Branch name prefix |
| `--open-pr` | boolean | `false` | Create a GitHub pull request after fix (implies `--create-branch`; requires `gh` CLI) |
| `--pr-title <title>` | string | auto-generated | Pull request title |

**Pipeline phases:**

The fix command runs the following phases in order:

1. **scan** — runs OSV Scanner as Gate A; classifies vulnerabilities.
2. **npm** — updates npm packages (if npm ecosystem is configured).
3. **composer** — updates PHP packages (if composer ecosystem is configured).
4. **pip** — updates Python packages (if pip ecosystem is configured).
5. **report** — generates the executive HTML report.

Use `--phases` to run only a subset:

```bash
# Run scan and npm phases only
deep-health fix --phases scan,npm

# Run all phases except the report
deep-health fix --no-report
```

**Authorizing breaking changes:**

```bash
# Allow composer packages to be updated to breaking versions
deep-health fix --authorize-breaking composer

# Allow both npm and composer breaking updates
deep-health fix --authorize-breaking npm composer
```

Authorization is per-run and is never persisted to the config file.

**Kill-switch environment variable:**

```bash
# Skip all automated fixes after the scan phase
DEEP_HEALTH_NO_AUTO_FIX=1 deep-health fix
```

This is useful in CI pipelines where you want the scan result logged but no files mutated.

**Git/PR workflow:**

```bash
# Create a branch, apply fixes, commit on success
deep-health fix --create-branch

# Create a branch AND open a GitHub PR
deep-health fix --open-pr

# Custom branch prefix
deep-health fix --create-branch --branch-prefix deps/security-fix-

# Custom PR title
deep-health fix --open-pr --pr-title "chore: security dependency updates"
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | All resolved (or nothing to fix) |
| `1` | Vulnerabilities found / update errors / pending vulns remain |
| `2` | Gate validation failure or scanner error |
| `3` | Configuration error |

**Per-ecosystem pipeline detail:**

For each ecosystem plugin:
1. Runs advisors (informational — never blocks the pipeline).
2. Skips the plugin if there are no `auto_safe` vulnerabilities (and no `breaking` with `--authorize-breaking`).
3. Resolves the Docker container runner (npm/pip/composer).
4. For npm: auto-demotes `osv`/`osv-then-audit` strategy to `npm-audit` if `package-lock.json` has `lockfileVersion: 1` (osv-scanner cannot patch v1 lockfiles in-place).
5. Calls the plugin's updater.
6. Optionally installs breaking packages (`--authorize-breaking`).
7. Runs post-update OSV residual verification to confirm fixes took effect.
8. Validates the update result against the ecosystem gate (Zod schema).

On success: applies the updates and runs validation commands.
On validation failure: reverts all changes to that ecosystem and continues with others.

---

### `executive-report`

Generates an executive HTML report from the last scan results.

```
deep-health executive-report [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-c, --config <path>` | string | `./project-config.yml` | Path to config file |
| `--cwd <path>` | string | current directory | Working directory |
| `--client <name>` | string | from config | Client name (overrides `project.client` in config) |
| `--project <name>` | string | from config | Project name (overrides `project.name` in config) |
| `-o, --output <path>` | string | reports dir | Write report to file |
| `--dry-run` | boolean | `false` | Show commands without executing |
| `-v, --verbose` | boolean | `false` | Enable verbose output |
| `-q, --quiet` | boolean | `false` | Suppress all output except errors and the final report |
| `--json` | boolean | `false` | Output results as JSON |

**What it does:**

1. Runs a fresh vulnerability scan (before state).
2. Runs the full orchestrator pipeline.
3. Renders the executive HTML report via Handlebars templates.
4. Saves the report to the configured output directory.
5. Optionally uploads to Google Drive if `cloud_storage` is configured.

The report language is controlled by `report_language` in `project-config.yml` (`en` or `pt-br`).

**Example:**

```bash
# Generate report with a custom client name
deep-health executive-report --client "Acme Corp" --output report.html
```

---

### `cloud-setup`

Interactive Google Drive folder picker. Saves the chosen folder ID to `project-config.yml` so that future `fix` and `executive-report` runs automatically upload their reports.

```
deep-health cloud-setup [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-c, --config <path>` | string | `./project-config.yml` | Path to config file |
| `--cwd <path>` | string | current directory | Working directory |

**Prerequisites:**

Google OAuth credentials must be available. The CLI reads the following environment variables:

- `GOOGLE_CLIENT_ID` — your OAuth 2.0 client ID
- `GOOGLE_CLIENT_SECRET` — your OAuth 2.0 client secret

To obtain credentials:
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the Google Drive API
4. Create OAuth 2.0 credentials (Desktop app type)
5. Copy the client ID and secret into your environment

**What it does:**

1. Checks for stored OAuth tokens (from a previous `cloud-setup` run).
2. If not already authenticated, opens the Google OAuth 2.0 authorization URL in your browser using `execFile` with `shell: false` (no shell injection possible).
3. After authentication, lists your Google Drive folders.
4. Presents an interactive folder selector.
5. Writes the selected `folder_id` to `cloud_storage.google_drive.folder_id` in `project-config.yml`.

**Example workflow:**

```bash
# Set up Google Drive integration
deep-health cloud-setup

# After setup, fix runs will upload the report automatically
deep-health fix

# To require upload success (fail CI if upload fails)
# Set in project-config.yml:
#   cloud_storage:
#     require_upload: true
```

---

## Configuration Reference

`project-config.yml` is the single source of truth for all deep-health behavior. Below is a fully annotated reference covering every field.

### `project`

```yaml
project:
  name: 'My Project'    # Required. Project name used in reports.
  client: 'Acme Corp'   # Required. Client name used in reports.
```

### `report_language`

```yaml
report_language: 'en'   # 'en' (default) | 'pt-br'
```

Controls the locale for generated executive reports. Affects all text in the HTML and Markdown reports. Does not affect CLI output.

### `config_version`

```yaml
config_version: '1'    # Optional. For forward-compatibility detection.
```

### `ecosystems`

Declarative list of ecosystems to scan and update. At least one entry is required.

```yaml
ecosystems:
  - id: 'npm'
    fixer: 'osv-then-audit'          # osv | npm-audit | osv-then-audit
    validationCommands:
      - name: 'Tests'
        command: 'npm test'
        timeout_seconds: 120          # optional; default: 300 (5 minutes)
    advisors:
      - name: 'audit'
        command: 'npm audit --json'
        format: 'json'               # json | text (default: text)

  - id: 'composer'
    fixer: 'osv'
    validationCommands:
      - name: 'Tests'
        command: 'php artisan test'
        timeout_seconds: 300
    advisors: []

  - id: 'pip'
    fixer: 'osv'
    validationCommands:
      - name: 'Tests'
        command: 'pytest'
```

**Ecosystem fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `npm` \| `composer` \| `pip` | Yes | Ecosystem identifier |
| `fixer` | string | No | Fixer strategy (see [Fixer Strategies](#fixer-strategies)) |
| `validationCommands` | array | No | Commands run after updates to verify nothing broke |
| `validationCommands[].name` | string | Yes | Human-readable label for the command |
| `validationCommands[].command` | string | Yes | Shell command string (runs inside the Docker container) |
| `validationCommands[].timeout_seconds` | number | No | Timeout in seconds; default: 300 |
| `advisors` | array | No | Informational commands that run before updates (never blocks the pipeline) |
| `advisors[].name` | string | Yes | Human-readable label |
| `advisors[].command` | string | Yes | Shell command string |
| `advisors[].format` | `json` \| `text` | No | Output format; use `json` for `npm audit --json` |

**Security note on `validationCommands`:** These run inside the ecosystem's Docker container via `sh -c`. They are not exposed to external input — only commands authored in `project-config.yml` (which you control) are executed. Commands starting with `git`, `gh`, or `open` are exempted and run on the host.

### `protected_packages`

Packages listed here are never updated beyond their declared constraint. Any update requiring a constraint change requires explicit `--authorize-breaking`.

```yaml
protected_packages:
  npm:
    - package: 'tailwindcss'
      constraint: '^3.3.3'
      reason: 'Tailwind v4 has breaking config and migration requirements'
    - package: 'react'
      constraint: '^18.0.0'
      reason: 'React 19 migration requires full QA cycle'
  composer:
    - package: 'laravel/framework'
      constraint: '^10.8'
      reason: 'Major upgrade to Laravel 11 requires a dedicated project'
  pip:
    - package: 'django'
      constraint: '>=4.2,<5.0'
      reason: 'Django 5.x has breaking changes'
```

**Fields per entry:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `package` | string | Yes | Package name as it appears in the lockfile |
| `constraint` | string | Yes | The version constraint that must not be exceeded |
| `reason` | string | Yes | Human-readable reason (appears in reports) |

### `safe_update_policy`

```yaml
safe_update_policy:
  allow_patch_and_minor_within_constraints: true    # default: true
  require_authorization_for_constraint_change: true  # default: true
```

| Field | Default | Description |
|-------|---------|-------------|
| `allow_patch_and_minor_within_constraints` | `true` | Automatically apply patch and minor updates that stay within current `^` / `~` / `>=` constraints |
| `require_authorization_for_constraint_change` | `true` | Require `--authorize-breaking` for any update that would change the declared version constraint |

### `conflict_resolution`

```yaml
conflict_resolution: 'manual'  # currently only 'manual' is supported
```

### `scanners`

Controls which scanning engines are used and how they are configured.

```yaml
scanners:
  primary: 'osv'           # Engine id used as Gate A source. Default: 'osv'
  osv:
    runner: 'docker'       # docker (default) | local | auto
    image: 'ghcr.io/google/osv-scanner:latest'   # optional; default shown
    args: []               # optional: additional CLI args forwarded to osv-scanner
  sonarqube:
    enabled: false         # set true to enable SonarQube integration
    mode: 'external'       # external (default) | managed
    on_failure: 'warn'     # warn (default) | fail
    # external mode: reads from sonar-project.properties; SONAR_TOKEN env var supplies auth.
    # managed mode: CLI provisions an ephemeral SonarQube CE container, generates a token,
    #               then tears it down after the scan.
    scanner_image: 'sonarsource/sonar-scanner-cli:latest'   # optional
    server_image: 'sonarqube:lts-community'                 # optional (managed mode only)
    send_branch_name: false        # Developer/Enterprise edition only; false = CE-safe
    ce_task_timeout_seconds: 120   # seconds to wait for CE task completion
    scanner_timeout_seconds: 300   # seconds before killing the sonar-scanner process
    dynamic_timeout: true          # scale timeouts based on ncloc from previous analysis
    timeout_scale:
      scanner_seconds_per_kloc: 3  # seconds of scanner budget per 1000 lines
      ce_seconds_per_kloc: 1.5     # seconds of CE budget per 1000 lines
    scanner_jvm_opts: '-Xmx2048m'  # optional; increase heap for large codebases
```

**OSV runner modes:**

| Mode | Behavior |
|------|----------|
| `docker` | Always run osv-scanner via an ephemeral Docker container. **Default and recommended.** |
| `local` | Use the locally installed `osv-scanner` binary. Fails if not installed. Emits a warning. |
| `auto` | Try local first; fall back to Docker if unavailable. **Deprecated escape hatch — emits a warning.** |

### `runners`

Per-ecosystem container configuration. Controls which Docker image is used, the runtime version, and optional OS-level dependencies.

```yaml
runners:
  npm:
    mode: 'docker'            # docker (default) | local | auto
    language_version: '20'    # inferred from .nvmrc / package.json if absent
    image: 'node:20'          # explicit override; takes precedence over language_version
    image_source: 'pull'      # pull (default) | dockerfile
    dockerfile_path: './Dockerfile'   # required when image_source='dockerfile'
    build_context: '.'                # defaults to project root
    build_args:                       # passed as --build-arg KEY=VALUE to docker build
      NODE_VERSION: '20'
    native_deps:              # OS packages to apt-get install before npm commands
      - libvips-dev           # required by sharp@0.x
      - build-essential       # required by native addons using node-gyp
      - python3               # required by node-gyp on some distros
    allow_build_context_escape: false   # security: allow build context outside project root

  composer:
    mode: 'docker'
    language_version: '8.1'   # inferred from .php-version / composer.json if absent
    image: 'php:8.1-cli'      # explicit override
    image_source: 'pull'      # pull | dockerfile
    dockerfile_path: './Dockerfile'
    build_context: '.'
    build_args: {}
    ignore_platform_reqs: true   # default true in docker mode; passes --ignore-platform-reqs
    native_deps:
      - imagemagick
      - libmagickwand-dev

  pip:
    mode: 'docker'
    language_version: '3.11'  # inferred from runtime.txt / .python-version if absent
    image: 'python:3.11-slim' # explicit override
    image_source: 'pull'      # pull | dockerfile
    dockerfile_path: './Dockerfile'
    build_context: '.'
    build_args: {}
    native_deps:
      - libjpeg-dev            # required by Pillow
      - libpq-dev              # required by psycopg2
```

**Runner mode options (same for npm, composer, pip):**

| Mode | Behavior |
|------|----------|
| `docker` | Run inside an ephemeral Docker container. **Default and recommended.** |
| `local` | Use the locally installed binary. Emits a warning. |
| `auto` | Try local first; fall back to Docker. **Deprecated — emits a warning.** |

### `scan` (scan paths)

Controls which paths `osv-scanner` inspects.

```yaml
scan:
  auto_discover: true    # default: true; also scan project root for lockfiles
  paths:                 # explicit paths to scan
    - 'frontend/'        # directories (trailing /) are scanned recursively via -r
    - 'backend/package-lock.json'   # explicit file paths use --lockfile
  exclude:               # paths to exclude
    - 'vendor/'
    - 'node_modules/'
```

**Constraints on paths:** All entries must be relative (no leading `/`) and must not contain `..` segments or glob characters. Paths resolve relative to `/project` inside the container.

### `outputs`

Controls report output location and formats.

```yaml
outputs:
  dir: './reports'            # output directory; default: .deep-health/reports
  sub_folders: false          # when true, engine reports go into sub-folders (sonarqube/)
  formats:
    - 'markdown'              # HTML is always generated; markdown is opt-in
```

The executive HTML report is always generated. Markdown is generated only when `markdown` is included in `formats`.

### `cloud_storage`

Configures automatic report upload to Google Drive after each `fix` or `executive-report` run.

```yaml
cloud_storage:
  provider: 'google_drive'    # only google_drive is supported
  google_drive:
    folder_id: 'YOUR_FOLDER_ID'    # set by cloud-setup command
  require_upload: false            # if true, exit 1 when upload fails
```

Run `deep-health cloud-setup` to authenticate and select the folder interactively.

### `workflow`

Git/PR workflow configuration. CLI flags always override these values.

```yaml
workflow:
  create_branch: false              # create a git branch before applying fixes
  open_pr: false                    # push branch and open a GitHub PR on success
  branch_prefix: 'fix/deep-health-' # prefix for auto-generated branch names
  pr_title: ''                      # custom PR title; auto-generated when absent
```

CLI flags (`--create-branch`, `--open-pr`, `--branch-prefix`, `--pr-title`) take precedence over these values per invocation.

---

## Docker and Runtime Strategies

All ecosystem CLIs (npm, composer, pip) and scanners (osv-scanner) run inside ephemeral Docker containers by default. This means:

- No local Node.js, PHP, or Python installation is needed beyond the deep-health CLI itself.
- Each run gets a clean, isolated environment.
- Container versions match the project's declared runtime (inferred or configured).
- Containers are removed automatically after each run (`--rm`).

### Image Source: pull vs dockerfile

Each runner supports two image strategies:

**`pull` (default):** Pull a pre-built image from Docker Hub or another registry.

```yaml
runners:
  npm:
    image_source: 'pull'
    language_version: '20'   # resolves to node:20
```

**`dockerfile`:** Build a local image from a project-owned Dockerfile. Use this when your project has non-standard system dependencies or a custom base image.

```yaml
runners:
  npm:
    image_source: 'dockerfile'
    dockerfile_path: '.docker/node.Dockerfile'
    build_context: '.'
    build_args:
      NODE_VERSION: '20'
      APP_ENV: 'production'
```

The `dockerfile` strategy is mutually exclusive with the `image` field. When `allow_build_context_escape: true`, the build context may reach outside the project root — this emits a warning because it sends a larger directory tree to the Docker daemon.

### Runtime Version Resolution

When `image` is not set, the runner resolves the Docker image from the runtime version using this precedence:

**npm:**
1. `runners.npm.language_version` from config (e.g. `'20'` → `node:20`)
2. Inferred from `.nvmrc` / `.node-version` / `package.json#engines.node`
3. Falls back to `node:lts`

**composer:**
1. `runners.composer.language_version` from config (e.g. `'8.2'` → `php:8.2-cli`)
2. Inferred from `.php-version` / `composer.json#require.php`
3. Falls back to `composer:2`

**pip:**
1. `runners.pip.language_version` from config (e.g. `'3.11'` → `python:3.11-slim`)
2. Inferred from `runtime.txt` / `.python-version`
3. Falls back to `python:3-slim`

### Native OS Dependencies

Some npm packages (e.g. `sharp`, `canvas`) or PHP extensions (e.g. `imagick`) require OS-level libraries to compile. Use `native_deps` to install them via `apt-get` inside the ephemeral container:

```yaml
runners:
  npm:
    native_deps:
      - libvips-dev       # required by sharp
      - build-essential   # required by any native addon using node-gyp
      - python3           # required by node-gyp on some distros
  composer:
    native_deps:
      - imagemagick
      - libmagickwand-dev
  pip:
    native_deps:
      - libjpeg-dev       # Pillow
      - libpq-dev         # psycopg2
```

Packages are installed with `apt-get install -y --no-install-recommends` before the ecosystem CLI runs. Package names must follow Debian naming conventions (lowercase alphanumeric, hyphens, dots, plus signs only).

---

## Scanner Engines

### OSV Scanner

The primary scanning engine. OSV Scanner uses Google's [Open Source Vulnerabilities](https://osv.dev) database to find known vulnerabilities in lockfiles.

**Supported lockfiles:**
- `package-lock.json` (npm)
- `yarn.lock` (npm, read-only — updates via npm)
- `composer.lock` (PHP Composer)
- `requirements.txt`, `Pipfile.lock` (Python pip)

**Configuration:**

```yaml
scanners:
  primary: 'osv'     # OSV is the default Gate A source
  osv:
    runner: 'docker'
    image: 'ghcr.io/google/osv-scanner:latest'
    args:
      - '--experimental-call-analysis'   # optional extra flags
```

OSV Scanner runs in an ephemeral Docker container. The project directory is mounted read-only inside the container. No lockfiles are modified during the scan phase.

### SonarQube

An optional secondary scanning engine for code quality analysis.

**External mode** (default when enabled):

Uses a pre-existing SonarQube instance. Configuration comes from `sonar-project.properties` in the project root. Authentication uses the `SONAR_TOKEN` environment variable.

```yaml
scanners:
  sonarqube:
    enabled: true
    mode: 'external'
    on_failure: 'warn'   # warn | fail
```

Create `sonar-project.properties`:

```properties
sonar.projectKey=my-project
sonar.projectName=My Project
sonar.sources=src
sonar.exclusions=**/node_modules/**,**/vendor/**
sonar.host.url=https://sonarqube.example.com
```

Set the auth token:

```bash
export SONAR_TOKEN=your_token_here
```

**Managed mode:**

The CLI provisions an ephemeral SonarQube Community Edition container, runs the scan, then tears it down.

```yaml
scanners:
  sonarqube:
    enabled: true
    mode: 'managed'
    server_image: 'sonarqube:lts-community'
    scanner_image: 'sonarsource/sonar-scanner-cli:latest'
    on_failure: 'warn'
```

Note: `send_branch_name: true` requires SonarQube Developer Edition or higher. Community Edition does not support branch analysis.

**SonarQube results in reports:**

When SonarQube is enabled, the executive report includes:
- Quality Gate status (PASSED / FAILED)
- Quality Gate conditions
- Metrics: bugs, vulnerabilities, code smells, coverage, duplicated lines, NCLOC
- Issues by file

---

## Ecosystem Plugins and Fixer Strategies

### npm

Scans `package-lock.json` and applies npm dependency updates.

**Fixer strategies:**

| Strategy | Behavior |
|----------|----------|
| `osv` | OSV Scanner applies in-place fixes to `package-lock.json`. Breaking changes are applied separately by npm via `npm install <pkg>@<version>`. |
| `npm-audit` | Uses `npm audit fix` exclusively. OSV fix is not run in this path. |
| `osv-then-audit` | Applies OSV fix first, then runs `npm audit fix` on top. If validation fails after both, reverts the `npm-audit` portion and re-validates against the OSV-only state. **Default for npm.** |

**Auto-demotion:**

If `package-lock.json` has `lockfileVersion: 1` (npm ≤ 6), the `osv` and `osv-then-audit` strategies are automatically demoted to `npm-audit` because osv-scanner cannot patch v1 lockfiles in-place. This demotion is logged as a warning.

### composer

Scans `composer.lock` and applies PHP package updates using Composer.

**Fixer strategy:**

| Strategy | Behavior |
|----------|----------|
| `osv` | OSV Scanner identifies vulnerable packages; Composer is used to update them. **Only strategy available for composer.** |

**Default image:** `php:<version>-cli` (e.g. `php:8.2-cli`)

**Platform requirements:** `ignore_platform_reqs: true` is set by default in Docker mode because the container is not the production environment — PHP extension checks against the container's PHP build are irrelevant.

### pip

Scans `requirements.txt` or `Pipfile.lock` and applies Python package updates using pip.

**Fixer strategy:**

| Strategy | Behavior |
|----------|----------|
| `osv` | OSV Scanner identifies vulnerable packages; pip is used to update them. **Only strategy available for pip.** |

**Default image:** `python:<version>-slim` (e.g. `python:3.11-slim`)

### Fixer Strategies

| Strategy | Ecosystems | Description |
|----------|------------|-------------|
| `osv` | npm, composer, pip | OSV Scanner performs in-place fixes to lockfiles. This is the primary and most accurate method — fixes are sourced directly from the OSV database. |
| `npm-audit` | npm only | Delegates fix to `npm audit fix`. Faster but less precise than OSV for complex dependency trees. |
| `osv-then-audit` | npm only | Applies OSV fix first for precision, then runs `npm audit fix` to catch any remaining issues. Falls back gracefully to OSV-only if audit-fix causes validation failures. |

---

## Protected Packages and Safe Update Policy

The protected packages and safe update policy mechanisms work together to prevent accidental breaking changes.

### How Protection Works

1. When a vulnerability is found in a protected package:
   - If the fix stays within the declared `constraint`, it is classified as `auto_safe` and applied normally.
   - If the fix requires exceeding the `constraint` (e.g. `^3.x` → `^4.x`), it is classified as `breaking` and skipped.

2. `breaking` vulnerabilities are reported in the executive report with the reason for why they were not fixed.

3. To apply a breaking update to a protected package:
   ```bash
   deep-health fix --authorize-breaking npm
   ```
   This authorizes all breaking updates for npm in this run. Authorization is not persisted.

### Safe Update Policy Rules

```yaml
safe_update_policy:
  allow_patch_and_minor_within_constraints: true
  require_authorization_for_constraint_change: true
```

With the defaults above:
- `lodash@4.17.19` → `lodash@4.17.21` (patch within `^4.17.0`) → **auto-applied**
- `lodash@4.17.21` → `lodash@5.0.0` (major bump, constraint change needed) → **blocked, authorization required**

---

## Git Branch and PR Workflow

By default, `deep-health fix` mutates the working tree directly (in-place). Use `--create-branch` to wrap the fix in a reviewable git branch.

### Branch Lifecycle

```bash
deep-health fix --create-branch
```

1. Detects the current git branch.
2. Creates a new branch: `fix/deep-health-<ISO-timestamp>` (e.g. `fix/deep-health-2026-05-06T14:30:00.000Z`).
3. Runs the full fix pipeline on the new branch.
4. On success: stages all changes and commits with message: `fix: apply safe dependency updates [deep-health]`
5. On failure: checks out the original branch and deletes the fix branch. No commit is made.

### PR Creation

```bash
deep-health fix --open-pr
```

Implies `--create-branch`. After a successful commit:

1. Runs `git push origin <branch>`.
2. Runs `gh pr create` with an auto-generated title and body.

The PR body includes:
- Ecosystem summary (which ecosystems were updated)
- deep-health version attribution
- `Co-authored with deep-health v<version>`

**Prerequisites:** `gh` CLI installed and authenticated (`gh auth login`).

### Custom Configuration

```bash
# Custom branch prefix
deep-health fix --create-branch --branch-prefix deps/security-fix-

# Custom PR title
deep-health fix --open-pr --pr-title "chore: automated security dependency updates"
```

Or set in `project-config.yml` (CLI flags always override):

```yaml
workflow:
  create_branch: true
  open_pr: true
  branch_prefix: 'deps/security-'
  pr_title: 'chore: security dependency updates'
```

---

## CI/CD Integration

### GitHub Actions — Scan Only

The simplest CI integration: scan on a schedule and on lockfile changes.

```yaml
# .github/workflows/security-scan.yml
name: Security scan

on:
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6am UTC
  push:
    paths:
      - 'composer.lock'
      - 'package-lock.json'
      - 'requirements.txt'
      - 'Pipfile.lock'

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '26'

      - name: Install deep-health
        run: npm install -g deep-health

      - name: Run vulnerability scan
        run: deep-health scan --json --output scan-results.json

      - name: Upload scan results
        uses: actions/upload-artifact@v4
        with:
          name: scan-results
          path: scan-results.json
```

### GitHub Actions — Auto-fix with PR

Full automation: scan, fix, and open a PR when vulnerabilities are found.

```yaml
# .github/workflows/security-fix.yml
name: Security auto-fix

on:
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6am UTC

jobs:
  fix:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '26'

      - name: Install deep-health
        run: npm install -g deep-health

      - name: Apply safe fixes and open PR
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: deep-health fix --open-pr
```

### GitHub Actions — Scan Only (Kill-switch)

Use the kill-switch to get the scan result in CI without applying any fixes:

```yaml
- name: Scan (no fixes)
  run: DEEP_HEALTH_NO_AUTO_FIX=1 deep-health fix --json --output scan-results.json
```

### CI exit code handling

deep-health exit codes integrate naturally with CI pipelines:

```bash
# Fail the pipeline if vulnerabilities are found
deep-health scan
echo "Exit code: $?"

# Allow exit 1 (vulnerabilities) but fail on config errors (3)
deep-health scan || [ $? -le 1 ]
```

---

## Environment Variables

| Variable | Effect |
|----------|--------|
| `DEEP_HEALTH_NO_AUTO_FIX=1` | Skips all automated fixes after the scan phase. The scan still runs and the exit code still reflects vulnerability status. Useful in pipelines where you want the scan result without file mutations. |
| `NPM_DEFAULT_FIXER` | Overrides the default npm fixer strategy. Valid values: `osv`, `npm-audit`, `osv-then-audit`. Default: `osv-then-audit`. |
| `CLI_NAME` | Overrides the CLI binary name used in user-visible output and the kill-switch variable name. Default: `deep-health`. When set to `security-scan`, the kill-switch becomes `SECURITY_SCAN_NO_AUTO_FIX`. |
| `LOG_LEVEL=debug` | Enables debug-level logging for detailed internal output. |
| `SONAR_TOKEN` | Authentication token for SonarQube in `external` mode. Required when SonarQube is enabled with `mode: external`. |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID. Required for `cloud-setup` and Google Drive upload. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret. Required for `cloud-setup` and Google Drive upload. |

---

## Exit Codes

All commands follow the same exit code convention:

| Code | Meaning | When it occurs |
|------|---------|----------------|
| `0` | Clean — success | No vulnerabilities found, or all vulnerabilities resolved |
| `1` | Issues found | Vulnerabilities found, update errors, or pending vulnerabilities remain after fix |
| `2` | Scanner/gate error | Gate validation failure, OSV error, or unexpected scanner failure |
| `3` | Configuration error | `project-config.yml` not found, invalid schema, or `init` output path error |

These codes make deep-health usable as a gate in CI/CD pipelines:

```bash
deep-health scan && echo "Clean!" || echo "Issues found (code $?)"
```

---

## Troubleshooting

### "deep-health requires Node.js >=26"

```
deep-health requires Node.js >=26. Detected: v20.x.x
Please upgrade Node.js and try again.
```

Upgrade Node.js to version 26 or later. Use [nvm](https://github.com/nvm-sh/nvm) for easy version management:

```bash
nvm install 26
nvm use 26
```

### "Config file not found"

```
Config file not found: ./project-config.yml
Run "deep-health init" first.
```

Generate a config file:

```bash
deep-health init
```

Or specify the path explicitly:

```bash
deep-health scan --config /path/to/project-config.yml
```

### Docker not available

```
Error: docker: command not found
```

Install Docker from [docs.docker.com](https://docs.docker.com/get-docker/) and ensure the Docker daemon is running:

```bash
docker --version
docker ps
```

### "File already exists" during init

```
File already exists: ./project-config.yml
Use --force to overwrite.
```

Use `--force` to regenerate the config:

```bash
deep-health init --force
```

### SonarQube "SONAR_TOKEN not set"

```
SONAR_TOKEN environment variable is required for SonarQube external mode
```

Set the token:

```bash
export SONAR_TOKEN=your_token_here
deep-health scan
```

Or add it to your CI environment secrets.

### Breaking vulnerabilities not fixed

This is expected behavior. Vulnerabilities classified as `breaking` require explicit authorization:

```bash
deep-health fix --authorize-breaking npm composer
```

Check the scan output for which packages need authorization.

### npm audit fix causes validation failure

When using `osv-then-audit` strategy and `npm audit fix` breaks validation, deep-health automatically reverts the `npm audit fix` portion and re-validates against the OSV-only state. If the OSV-only state also fails validation, all npm changes are reverted.

### `gh` CLI not found for PR creation

```
--open-pr requires the GitHub CLI (gh). Install it from https://cli.github.com and run: gh auth login
```

Install `gh` and authenticate:

```bash
# macOS
brew install gh

# Linux
# See https://github.com/cli/cli/blob/trunk/docs/install_linux.md

gh auth login
```

### Google Drive upload fails

If `require_upload: false` (default), upload failures are non-fatal — a warning is printed to stderr. If `require_upload: true`, the command exits with code `1`.

Run `deep-health cloud-setup` to re-authenticate if tokens have expired.

### Validation commands time out

Increase `timeout_seconds` for the relevant validation command:

```yaml
ecosystems:
  - id: composer
    validationCommands:
      - name: 'Tests'
        command: 'php artisan test'
        timeout_seconds: 600    # increase from default 300
```

---

## FAQ

**Q: Does deep-health modify my lockfiles directly?**

Yes. When you run `deep-health fix`, it modifies `package-lock.json`, `composer.lock`, and `requirements.txt` / `Pipfile.lock` inside ephemeral Docker containers. Use `--create-branch` to contain those changes to a reviewable branch, or `--dry-run` to see what would happen without making changes.

**Q: What happens if my test suite fails after an update?**

deep-health automatically reverts all changes to that ecosystem and continues with others. The failed ecosystem is reported as "reverted" in the executive report.

**Q: Can I use deep-health with a monorepo?**

Yes. Use `scan.paths` to specify which subdirectories to scan:

```yaml
scan:
  auto_discover: false
  paths:
    - 'packages/frontend/'
    - 'packages/backend/'
```

**Q: Does deep-health support yarn or pnpm?**

Currently only npm (`package-lock.json`) and yarn v1 (`yarn.lock`, read-only scanning only) are supported. pnpm is not yet supported.

**Q: Can I run deep-health without Docker?**

Docker is required for running ecosystem CLIs (npm, composer, pip) in the fix phase. OSV Scanner also uses Docker by default, though it can be run locally with `runners.osv.runner: 'local'`. The `local` mode for ecosystem runners is available but not recommended and emits a warning.

**Q: What does "authorization required" mean in the report?**

It means the fix requires a major version bump (e.g. `v3` → `v4`) or a change to the declared constraint. This is never applied automatically. To authorize it:

```bash
deep-health fix --authorize-breaking <ecosystem>
```

**Q: How do I add a new ecosystem to an existing config?**

Add a new entry to `ecosystems` in `project-config.yml`:

```yaml
ecosystems:
  - id: pip
    fixer: 'osv'
    validationCommands:
      - name: 'Tests'
        command: 'pytest'
```

**Q: Are my secrets safe with SonarQube managed mode?**

In managed mode, the CLI generates a temporary token via the SonarQube admin API and passes it as a CLI argument (not written to disk). `sonar.login` / `sonar.password` fields in `sonar-project.properties` are stripped via a sanitized temp copy (sonar-scanner 5+ rejects their presence).

**Q: How do I pin the OSV Scanner version?**

```yaml
scanners:
  osv:
    image: 'ghcr.io/google/osv-scanner:v1.9.0'
```

**Q: Can I generate reports in both English and Portuguese?**

Not in a single run. Set `report_language` to either `en` or `pt-br`. To generate both, run `executive-report` twice with different config files.

**Q: Is deep-health open source?**

Yes. Licensed under MIT.
