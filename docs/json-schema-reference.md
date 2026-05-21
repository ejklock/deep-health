# JSON Schema Reference — security-scan

When `--json` is passed to `scan` or `fix`, the output conforms to the schemas described here. These are also the contracts enforced by Gate A and the ecosystem gates.

---

## ScanResultJson

Produced by `security-scan scan --json` and available in `OrchestratorResult.scan`.

**Schema identifier:** `osv-scan-result/v1`

```jsonc
{
  "$schema": "osv-scan-result/v1",
  "agent": "osv",                          // engine id that produced this result
  "status": "success",                     // "success" | "error" | "skipped"
  "environment": "docker",                 // "docker" | "local"
  "branch": "main",                        // git branch at scan time; null if unknown
  "error": null,                           // error message string when status="error"
  "ecosystems": {
    "npm": {
      "vulnerabilities_total": 3,
      "auto_safe": 2,                      // count of packages with auto_safe classification
      "breaking": 1,                       // count requiring --authorize-breaking
      "manual": 0,                         // count with no available fix
      "auto_safe_packages": [              // package@version strings
        "lodash@4.17.20",
        "semver@6.3.0"
      ],
      "breaking_packages": [
        "webpack@4.46.0"                   // package@currentVersion
      ],
      "manual_packages": [],
      "vulnerabilities": [                 // full detail per vulnerability
        {
          "ecosystem": "npm",
          "package": "lodash",
          "currentVersion": "4.17.20",
          "safeVersion": "4.17.21",        // null when no fix is available
          "cvss": "9.8",
          "ghsaId": "GHSA-35jh-r3h4-6jhm",
          "risk": "CRITICAL",
          "classification": "auto_safe",   // "auto_safe" | "breaking" | "manual"
          "reason": "Patch update: 4.17.20 → 4.17.21",
          "breakingReason": null           // "major-bump" | "protected-constraint" | null
        }
      ]
    },
    "packagist": {                         // composer ecosystem uses "packagist" as the OSV key
      "vulnerabilities_total": 0,
      "auto_safe": 0,
      "breaking": 0,
      "manual": 0,
      "auto_safe_packages": [],
      "breaking_packages": [],
      "manual_packages": [],
      "vulnerabilities": []
    }
  },
  "metadata": null                         // SonarQubeMetadata when SonarQube engine ran; see below
}
```

### Field notes

| Field | Notes |
|---|---|
| `status` | Gate A rejects `"error"`. Consumers should check this before reading `ecosystems`. |
| `agent` | Always `"osv"` for the primary result. Identifies which engine produced the data. |
| `branch` | `null` in detached-HEAD state (e.g. CI SHA checkout). |
| `ecosystems` | Keys are OSV ecosystem strings. npm uses `"npm"`, Composer uses `"packagist"`, pip uses `"PyPI"`. |
| `auto_safe_packages` | Format is `package@currentVersion`. The `@version` suffix is the **current** (vulnerable) version, not the safe version. |
| `breaking_packages` | Same format. Packages here require `--authorize-breaking <eco>` to update. |
| `manual_packages` | Cannot be updated automatically in any way. Require manual review. |
| `breakingReason` | Only set when `classification === "breaking"`. `"major-bump"` = semver major increase needed. `"protected-constraint"` = safe version is outside the declared constraint in `protected_packages`. |

### `metadata` — SonarQube (when enabled)

Present only when the SonarQube engine ran. `null` in all other cases.

```jsonc
{
  "metadata": {
    "qualityGateStatus": "OK",           // "OK" | "WARN" | "ERROR"
    "qualityGatePassed": true,
    "qualityGateConditions": [
      {
        "status": "OK",
        "metricKey": "new_reliability_rating",
        "comparator": "GT",
        "errorThreshold": "1",
        "actualValue": "1"
      }
    ],
    "metrics": {                          // raw metric key → value map (optional)
      "coverage": "87.3",
      "duplicated_lines_density": "2.1"
    },
    "issues": [                           // individual SonarQube issues (optional)
      {
        "key": "AX...",
        "rule": "typescript:S1234",
        "severity": "MAJOR",
        "component": "src/index.ts",
        "line": 42,
        "message": "Refactor this code",
        "type": "CODE_SMELL",
        "status": "OPEN"
      }
    ]
  }
}
```

---

## UpdateResultJson

Produced per ecosystem by `plugin.runUpdater()`. Available in `OrchestratorResult.updates["npm"]`, etc.

**Schema identifier:** `osv-update-result/v1`

```jsonc
{
  "$schema": "osv-update-result/v1",
  "agent": "npm",                         // plugin id
  "status": "success",                    // "success" | "error" | "skipped"
  "packages_updated": [                   // packages that were successfully updated
    "lodash@4.17.20 → 4.17.21",
    "semver@6.3.0 → 6.3.1"
  ],
  "packages_skipped": [                   // packages skipped (already safe, filtered out, etc.)
    "express@4.18.0"
  ],
  "packages_pending_breaking": [          // breaking packages; not updated (use --authorize-breaking)
    "webpack@4.46.0"
  ],
  "validations": [                        // MUST have at least one entry
    {
      "name": "tests",                    // short name, e.g. "tests", "build", "lint"
      "status": "pass",                   // "pass" | "fail" | "skipped"
      "detail": "npm test exited 0"       // optional human-readable detail
    },
    {
      "name": "build",
      "status": "skipped",
      "detail": "No build command configured"
    }
  ],
  "error": null                           // error message when status="error"
}
```

### Field notes

| Field | Notes |
|---|---|
| `status` | `"error"` means the update was rolled back. `"skipped"` means no packages needed updating. `"success"` means the update was applied (even if some packages were skipped). |
| `packages_updated` | Format is `name@fromVersion → toVersion`. Used in the executive report evidence table. |
| `validations` | **Must never be empty.** Gate schema enforces `min(1)`. Always emit at least one entry. Use `status: "skipped"` in dry-run or when no validation commands are configured. |
| `validations[].status: "fail"` | Triggers a revert of the update. The orchestrator reads `updateResult.status` (not `validations`) to decide whether to stop the pipeline — so a plugin must set `status: "error"` when any validation fails. |
| `packages_pending_breaking` | Populated from the scan result. These packages are not touched unless `--authorize-breaking` was given. |

---

## OrchestratorResult (full fix run)

The object returned by `runOrchestrator()` and written to stdout when `security-scan fix --json` is used.

```jsonc
{
  "scan": { /* ScanResultJson — before-fix snapshot */ },
  "updates": {
    "npm":      { /* UpdateResultJson */ },
    "composer": { /* UpdateResultJson */ },
    "pip":      { /* UpdateResultJson */ }
  },
  "overallStatus": "success",             // "success" | "error" | "skipped"
  "hasPendingVulns": false,               // true when breaking or manual vulns remain after fix
  "warnings": [                           // non-fatal engine warnings (e.g. SonarQube on_failure=warn)
    {
      "engineId": "sonarqube",
      "message": "SonarQube scan timed out"
    }
  ],
  "aggregated": {
    "primary": { /* ScanResultJson from OSV */ },
    "engineResults": {
      "sonarqube": { /* ScanResultJson from SonarQube */ }
    },
    "warnings": []
  },
  "advisorResults": {
    "npm": [
      {
        "command": "npm outdated",
        "output": "...",
        "status": "success"
      }
    ]
  },
  "residualVerification": {
    "status": "verified",                 // "verified" | "unverified" | "skipped"
    "summary": {                          // present when status != "skipped"
      "npm": 0,
      "packagist": 0
    }
  }
}
```

### `hasPendingVulns` vs `overallStatus`

These are separate signals and should not be conflated:

| `overallStatus` | `hasPendingVulns` | Meaning |
|---|---|---|
| `"success"` | `false` | All vulnerabilities resolved |
| `"success"` | `true` | Run succeeded, but breaking/manual vulns remain |
| `"error"` | `*` | Pipeline crashed or updater failed |
| `"skipped"` | `false` | No phases ran |

`security-scan fix` exits `1` for both `overallStatus === "error"` **and** `hasPendingVulns === true`. Both produce exit code `1` — checking `overallStatus` alone is not sufficient for CI.

### `residualVerification`

A best-effort post-update OSV re-scan to confirm CVEs were actually resolved.

| `status` | Meaning |
|---|---|
| `"verified"` | Post-update scan ran, all ecosystems show 0 CVEs |
| `"unverified"` | Post-update scan ran, ≥1 ecosystem still has CVEs (see `summary`) |
| `"skipped"` | Scan not run: dry-run mode, OSV error, or policy is `"never"` |

---

## Audit Trail (`.security-scan/runs/<timestamp>.json`)

Written after every `fix` run to `.security-scan/runs/` in the project directory. Never blocks the pipeline — failures are logged as warnings only.

```jsonc
{
  "timestamp": "2026-04-24T10:00:00.000Z",
  "cli_version": "1.2.3",
  "dry_run": false,
  "scan": { /* ScanResultJson — before-fix snapshot */ },
  "updates": {
    "npm": { /* UpdateResultJson */ }
  },
  "overall_status": "success",
  "has_pending_vulns": false
}
```

File name: `<timestamp-with-colons-replaced-by-hyphens>.json`
Example: `.security-scan/runs/2026-04-24T10-00-00.000Z.json`

Add `.security-scan/runs/` to `.gitignore` to prevent committing run history.

---

## Consuming `--json` Output in CI

```bash
# Capture JSON output
security-scan fix --json --output fix-result.json

# Read fields with jq
jq '.hasPendingVulns'            fix-result.json    # true/false
jq '.overallStatus'              fix-result.json    # success/error/skipped
jq '.updates.npm.packages_updated' fix-result.json # array of updated packages
jq '.scan.ecosystems.npm.breaking' fix-result.json # count of breaking vulns

# Check residual CVEs per ecosystem
jq '.residualVerification'       fix-result.json
```
