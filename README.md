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
project:
  name: 'My Project'
  client: 'Acme Corp'

runtime:
  php: '8.1'
  python: '3.11'               # optional — required when using pip ecosystem
  node: '20.x'
  package_manager_php: 'composer'
  package_manager_js: 'npm'
  package_manager_python: 'pip' # optional — pip | pipenv | poetry (pip default)
  execution: 'docker'          # docker | local
  docker_service: 'app'        # docker-compose service name (if using docker)
  test_command: 'php artisan test --compact'
  build_commands:
    frontend: 'npm run build'
    backend: 'npm run build:backend'

# Packages that must never be updated beyond their stated constraint.
# Any update requiring a constraint change needs explicit --authorize-breaking.
protected_packages:
  composer:
    - package: 'laravel/framework'
      constraint: '^10.8'
      reason: 'Major upgrade to Laravel 11 requires a dedicated project'
    - package: 'livewire/livewire'
      constraint: '^2.12'
      reason: 'Livewire 3 has breaking API changes'

  npm:
    - package: 'tailwindcss'
      constraint: '^3.3.3'
      reason: 'Tailwind v4 has breaking config and migration requirements'

  pip:
    - package: 'django'
      constraint: '>=4.2,<5.0'
      reason: 'Django 5.x has breaking changes; requires dedicated migration project'
    - package: 'celery'
      constraint: '>=5.3,<6.0'
      reason: 'Confirm broker compatibility before any major version change'

safe_update_policy:
  # Patch and minor updates within current constraints are applied automatically
  # when tests pass.
  allow_patch_and_minor_within_constraints: true
  # Constraint changes always require explicit human authorization.
  require_authorization_for_constraint_change: true
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
├── infrastructure # Config loading, Docker runners, executors
├── modules/
│   ├── ecosystem/ # npm and Composer plugins (updaters, fixers, validators)
│   └── scanner/   # OSV and SonarQube scan engines
├── orchestration/ # Main workflow coordinator
└── reporting/     # HTML report generation (Handlebars + i18n)
```

Ecosystem plugins and scanner engines are registered at runtime, making it straightforward to add new package managers (pip, bundler, etc.) or scanning engines without touching the core orchestrator.

---

## Security

### SEC-004 — Trust boundary for user-configured command strings

`deep-health` executes several command strings that are **read directly from `project-config.yml`** and are therefore under full control of the **repository owner**:

| Config field | Used by | Notes |
|---|---|---|
| `runtime.test_command` | fix workflow — post-update validation | Shell string; repo-owner controlled |
| `ecosystems[].validationCommands[]` | fix workflow — per-ecosystem validation | Shell string(s); repo-owner controlled |
| `ecosystems[].advisors[].command` | advisor step — informational only | Shell string; repo-owner controlled |

**Trust boundary:** these strings are treated as trusted configuration supplied by the repository owner (the same person who checks in `project-config.yml`).  They are **not** attacker-controlled in a normal deployment — an attacker who can modify `project-config.yml` already has write access to the repository.

**OAuth browser opener** (`cloud-setup`): the Google OAuth URL is opened via `execFile` with `shell: false`, passing the URL as a discrete `argv` element.  Shell metacharacters in the URL cannot cause command injection because no shell is involved in the spawn.

> If you use `deep-health` in a context where `project-config.yml` is written by untrusted parties, treat those command strings as untrusted input and review them before running the tool.

---

## License

MIT
