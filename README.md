# deep-health

Vulnerability scanning and safe dependency update CLI for PHP (Composer), Node.js (npm), and Python (pip) projects.

Scans for known vulnerabilities via [OSV Scanner](https://google.github.io/osv-scanner/), applies safe patch/minor updates within your declared constraints, and generates an executive HTML report — all without requiring any local tool installation beyond Docker.

---

## How it works

1. **Scan** — runs OSV Scanner against your `composer.lock`, `package-lock.json`, and `requirements.txt` / `Pipfile.lock`
2. **Fix** — applies patch/minor updates that don't break declared constraints; skips protected packages
3. **Report** — generates an HTML executive report with a vulnerability summary

Breaking changes (constraint bumps, major versions) are never applied automatically. They require explicit per-package authorization via `--authorize-breaking`.

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | ≥ 22.0.0 |
| Docker | any recent version |

Docker is used to run OSV Scanner (and optionally SonarQube) in ephemeral containers. No local installation of those tools is needed.

---

## Installation

```bash
npm install -g deep-health
```

Or run without installing:

```bash
npx deep-health --help
```

---

## Quick start

**1. Generate a config file**

```bash
deep-health init
```

This creates a `project-config.yml` in the current directory with sane defaults based on your runtime environment.

**2. Scan for vulnerabilities**

```bash
deep-health scan
```

**3. Scan and apply safe updates**

```bash
deep-health fix
```

That's it. Results are printed to stdout. Pass `--output report.html` to save the report to a file.

---

## Commands

### `init`

Generate a `project-config.yml` template.

```bash
deep-health init [options]

Options:
  --project-name <name>   Project name
  --client <name>         Client name
  --output <path>         Output path (default: ./project-config.yml)
  --force                 Overwrite existing file
```

### `scan`

Run the vulnerability scan only (no updates applied).

```bash
deep-health scan [options]

Options:
  -c, --config <path>     Path to project-config.yml (default: ./project-config.yml)
  --cwd <path>            Working directory (default: current directory)
  --dry-run               Show commands without executing
  -v, --verbose           Verbose output
  -q, --quiet             Suppress all output except errors and final report
  --json                  Output results as JSON
  -o, --output <path>     Write report to file
```

### `fix`

Full workflow: scan → apply safe updates → generate executive report.

```bash
deep-health fix [options]

Options:
  -c, --config <path>             Path to project-config.yml
  --phases <phases>               Comma-separated phases: scan,npm,composer,pip,report
                                  (default: "scan,npm,composer,pip")
  --no-report                     Skip executive report generation
  --authorize-breaking <id...>    Authorize breaking-change updates for the given
                                  ecosystem(s). Example: --authorize-breaking composer npm pip
  --dry-run                       Show commands without executing
  -v, --verbose                   Verbose output
  --json                          Output results as JSON
  -o, --output <path>             Write report to file
  --create-branch                 Create a git branch before applying fixes, commit on success
  --branch-prefix <prefix>        Branch name prefix (default: fix/deep-health-)
  --open-pr                       Open a GitHub PR after fix (implies --create-branch; requires gh CLI)
  --pr-title <title>              Pull request title (default: auto-generated)
```

### `executive-report`

Generate an executive HTML report from the last scan results.

```bash
deep-health executive-report [options]

Options:
  --client <name>     Client name (overrides project-config.yml)
  --project <name>    Project name (overrides project-config.yml)
  -o, --output <path> Write report to file
```

### `cloud-setup`

Interactive Google Drive folder picker — saves the selected folder ID to `project-config.yml` for automatic report distribution.

```bash
deep-health cloud-setup
```

---

## Configuration

`deep-health init` generates a starter `project-config.yml`. Here is a full annotated example:

```yaml
config_version: '1'

project:
  name: 'My Project'
  client: 'Acme Corp'

ecosystems:
  - id: 'npm'
    fixer: 'osv'                    # osv | npm-audit | osv-then-audit
    validationCommands:
      - name: 'tests'
        command: 'npm test'
        timeout_seconds: 120        # optional, default: 300 (5 min)
    advisors:
      - name: 'audit'
        command: 'npm audit --json'
        format: 'json'
  - id: 'composer'
    fixer: 'osv'
    validationCommands:
      - name: 'tests'
        command: 'php artisan test'

# Packages that must never be updated beyond their stated constraint.
# Any update requiring a constraint change needs explicit --authorize-breaking.
protected_packages:
  npm:
    - package: 'tailwindcss'
      constraint: '^3.3.3'
      reason: 'Tailwind v4 has breaking config and migration requirements'
  composer:
    - package: 'laravel/framework'
      constraint: '^10.8'
      reason: 'Major upgrade to Laravel 11 requires a dedicated project'

safe_update_policy:
  # Patch and minor updates within current constraints are applied automatically
  # when tests pass.
  allow_patch_and_minor_within_constraints: true
  # Constraint changes always require explicit human authorization.
  require_authorization_for_constraint_change: true

conflict_resolution: 'manual'

# Optional: configure scanner engines
scanners:
  primary: 'osv'          # engine id to use as Gate A source (default: 'osv')
  osv:
    runner: 'docker'      # docker | local | auto
  npm:
    mode: 'docker'        # docker | local | auto
    runtime_version: '20' # override Node version for Docker image
  composer:
    mode: 'docker'
    runtime_version: '8.2'
  pip:
    mode: 'docker'
    runtime_version: '3.11'
  sonarqube:
    enabled: false        # set true to enable SonarQube integration

# Optional: report output
outputs:
  formats: ['markdown']
  dir: 'reports'

# Optional: Google Drive report distribution
cloud_storage:
  provider: 'google_drive'
  folder_id: 'YOUR_FOLDER_ID'
  require_upload: false   # set true to fail CI when upload fails
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Clean — no vulnerabilities or all resolved |
| `1` | Vulnerabilities found / update errors |
| `2` | Gate validation failure or scanner error |
| `3` | Configuration error |

These codes make `deep-health` suitable for use in CI/CD pipelines.

---

## Git/PR Workflow

By default, `deep-health fix` mutates the working tree directly. Use `--create-branch` to wrap the fix in a reviewable Git branch:

```bash
# Create a branch, apply fixes, commit on success
deep-health fix --create-branch

# Create a branch AND open a GitHub PR (requires gh auth login)
deep-health fix --open-pr

# Custom branch prefix
deep-health fix --create-branch --branch-prefix deps/security-fix-
```

**Branch lifecycle:**
- Branch is created BEFORE any mutation: `fix/deep-health-<ISO-timestamp>`
- On success: changes are staged and committed as `fix: apply safe dependency updates [deep-health]`
- On failure: original branch is restored; no commit is made

**`--open-pr` prerequisites:** [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth login`). The PR body includes ecosystem summary and deep-health version attribution.

---

## CI/CD example

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
      - 'Pipfile.lock'

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
      # To apply fixes and open a PR automatically (requires GITHUB_TOKEN and gh CLI):
      # - run: deep-health fix --open-pr
      - uses: actions/upload-artifact@v4
        with:
          name: scan-results
          path: scan-results.json
```

---

## Development

```bash
git clone https://github.com/your-org/deep-health.git
cd deep-health/osv-security-cli
npm install
npm run dev -- --help
```

### Running tests

```bash
npm run test              # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration test
npm run test:smoke        # Smoke tests (requires Docker)
npm run test:coverage     # With coverage report
```

### Building

```bash
npm run build
```

Output goes to `dist/`.

---

## Architecture

```
src/
├── app/           # CLI commands and I/O
├── core/          # Domain types, gates, and safe-update policy
├── infrastructure/
│   ├── config/    # Config loading, Zod schema, and init templates
│   ├── executor/  # Container command runners (npm, pip, composer)
│   │              # Non-ecosystem validation commands routed via runShell()
│   ├── provisioner/ # Docker runners with retry backoff (withRetry)
│   ├── storage/   # Local + Google Drive (optional dependency)
│   └── utils/     # logger, git-branch, git-commit, retry, docker-platform
├── modules/
│   ├── ecosystem/ # npm, composer, pip plugins
│   └── scanner/   # OSV, SonarQube engines; ExternalScannerAdapter base class
├── orchestration/ # Main workflow coordinator
└── reporting/     # HTML report generation (Handlebars + i18n)
```

Ecosystem plugins and scanner engines are registered at runtime, making it straightforward to add new package managers (pip, bundler, etc.) or scanning engines without touching the core orchestrator.

---

## Security

### SEC-004 — Validation command execution

`validationCommands` and advisor commands from `project-config.yml` are now executed **inside the ecosystem's Docker container** (node, php, python) via `sh -c`, not on the host. This means:

- `jest --coverage`, `php artisan test`, `pytest` — run inside the project's pinned runtime container
- Only commands starting with `git`, `gh`, or `open` are exempted and run on the host

**Trust boundary:** these strings are authored by the repository owner (same person who checks in `project-config.yml`), not by external sources. Variable data (package names, versions, CVE ids) is never interpolated into validation command strings.

**OAuth browser opener** (`cloud-setup`): the Google OAuth URL is opened via `execFile` with `shell: false`, passing the URL as a discrete `argv` element. Shell metacharacters in the URL cannot cause command injection because no shell is involved in the spawn.

> If you use `deep-health` in a context where `project-config.yml` is written by untrusted parties, treat those command strings as untrusted input and review them before running the tool.

---

## License

MIT
