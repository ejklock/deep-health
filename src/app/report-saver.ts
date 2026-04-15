import { resolve } from "node:path";
import { LocalStorageProvider } from "@infra/storage/local";
import { createStorageProvider } from "@infra/storage/factory";
import {
  buildSonarQubeExport,
  sonarQubeExportFilename,
} from "@reporting/sonarqube-export";
import type { CloudStorageConfig } from "@core/types/config";
import type { StorageProvider } from "@infra/storage/provider";
import type { ScanResultJson } from "@core/types/scan";

/**
 * Save a report to local storage and optionally to cloud storage.
 * Local save failure is fatal; cloud failure is non-fatal (warns to stderr).
 */
export async function saveReport(
  filename: string,
  content: string,
  reportsDir: string,
  cloudStorageConfig: CloudStorageConfig | undefined,
  cwd: string,
): Promise<void> {
  const providers: StorageProvider[] = [new LocalStorageProvider(reportsDir)];
  if (cloudStorageConfig) {
    try {
      providers.push(await createStorageProvider(cloudStorageConfig, cwd));
    } catch (err) {
      process.stderr.write(
        `Cloud storage init failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  let localSaved = false;
  for (const provider of providers) {
    try {
      const result = await provider.upload(filename, content);
      process.stdout.write(
        `Report saved [${result.provider}]: ${result.url}\n`,
      );
      if (result.provider === "local") localSaved = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!localSaved) {
        // Local save failure is fatal
        throw new Error(`Failed to save report locally: ${msg}`);
      }
      // Cloud failure is non-fatal
      process.stderr.write(`Cloud upload failed: ${msg}\n`);
    }
  }
}

/**
 * Build and save the SonarQube detailed export when engine results are available.
 * Deduplicates the identical save block used in both fix and executive-report commands.
 *
 * @param engineResults - aggregated engine results from the orchestrator
 * @param projectName   - used to derive the export filename
 * @param date          - ISO date string (YYYY-MM-DD)
 * @param reportsDir    - absolute path to the local reports directory
 * @param cloudStorageConfig - optional cloud storage config
 * @param cwd           - working directory for cloud provider init
 */
export async function saveSonarQubeExport(
  engineResults: Record<string, ScanResultJson>,
  projectName: string,
  date: string,
  reportsDir: string,
  cloudStorageConfig: CloudStorageConfig | undefined,
  cwd: string,
): Promise<void> {
  const sonarExport = buildSonarQubeExport(engineResults);
  if (!sonarExport) return;

  const exportFilename = sonarQubeExportFilename(projectName, date);
  try {
    await saveReport(
      exportFilename,
      JSON.stringify(sonarExport, null, 2),
      reportsDir,
      cloudStorageConfig,
      cwd,
    );
  } catch (err) {
    process.stderr.write(
      `SonarQube export save failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Convenience helper: resolve the reports directory from cwd + config value.
 */
export function resolveReportsDir(
  cwd: string,
  configReportsDir: string | undefined,
): string {
  return resolve(cwd, configReportsDir ?? ".deep-health/reports");
}

/**
 * When sub_folders is enabled, engine-specific reports are placed in a named
 * sub-folder inside reportsDir.  Consolidated and executive reports always
 * stay at the root level (pass sub_folders=false for those).
 *
 * @param reportsDir   Absolute path to the base reports directory.
 * @param subFolder    Sub-folder name (e.g. 'sonarqube').  Pass undefined or
 *                     empty string to keep files at the root level.
 */
export function resolveEngineReportsDir(
  reportsDir: string,
  subFolder: string | undefined,
): string {
  if (!subFolder) return reportsDir;
  return resolve(reportsDir, subFolder);
}
