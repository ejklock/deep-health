import { CLI_NAME } from '@infra/brand';
import { runScanner } from '@modules/scanner/index';
import { generateExecutiveReport, executiveReportFilename } from '@reporting/executive';
import { generateSonarQubeHtmlReport, sonarqubeHtmlReportFilename } from '@reporting/sonarqube-report';
import { saveReport, resolveReportsDir, resolveEngineReportsDir } from '@app/report-saver';
import type { ProjectConfig } from '@core/types/config';
import type { ScanResultJson } from '@core/types/scan';
import type { UpdateResultJson } from '@core/types/update';
import type { AdvisorResult, ResidualVerification } from '@core/types/report';
import type { CommandRunner } from '@core/types/common';

export interface ReportArtifactsInput {
  runner: CommandRunner;
  cwd: string;
  config: ProjectConfig;
  /** Override the client name from config (e.g. --client CLI flag). */
  client?: string;
  /** Override the project name from config (e.g. --project CLI flag). */
  project?: string;
  scanBefore: ScanResultJson;
  updates: Record<string, UpdateResultJson>;
  engineResults?: Record<string, ScanResultJson>;
  advisorResults?: Record<string, AdvisorResult[]>;
  residualVerification?: ResidualVerification;
}

/**
 * Generate and save the post-pipeline report artefacts:
 *   1. Executive report (Markdown) — saved when outputs.formats includes 'markdown'
 *   2. SonarQube HTML report — saved alongside the executive report when sonar data is present
 *
 * Returns 0 on success. Returns 1 when a required cloud upload fails.
 * Never saves the audit trail — that remains the caller's responsibility.
 */
export async function generateAndSaveReportArtifacts(
  input: ReportArtifactsInput,
): Promise<number> {
  const {
    runner,
    cwd,
    config,
    scanBefore,
    updates,
    engineResults,
    advisorResults,
    residualVerification,
  } = input;

  const client = input.client ?? config.project.client;
  const project = input.project ?? config.project.name;
  const outputsConfig = config.outputs;

  const markdownEnabled = (outputsConfig?.formats ?? []).includes('markdown');
  if (!markdownEnabled) return 0;

  const reportsDir = resolveReportsDir(cwd, outputsConfig?.dir);
  const subFoldersEnabled = outputsConfig?.sub_folders ?? false;
  const sonarReportsDir = resolveEngineReportsDir(
    reportsDir,
    subFoldersEnabled ? 'sonarqube' : undefined,
  );

  const scanAfter = await runScanner(runner, config, cwd);

  const execReport = generateExecutiveReport({
    client,
    project,
    scanBefore,
    scanAfter,
    updates,
    engineResults,
    locale: config.report_language,
    advisorResults,
    residualVerification,
  });

  const filename = executiveReportFilename(client, project);
  const outcome = await saveReport(filename, execReport, reportsDir, config.cloud_storage, cwd);
  if (outcome.cloudError && config.cloud_storage?.require_upload) {
    process.stderr.write(
      `[${CLI_NAME}] Cloud upload required but failed: ${outcome.cloudError}\n`,
    );
    return 1;
  }

  // Standalone SonarQube HTML artifact
  const sonarHtml = generateSonarQubeHtmlReport(engineResults, client, project);
  if (sonarHtml) {
    const htmlFilename = sonarqubeHtmlReportFilename(client, project);
    const sonarOutcome = await saveReport(
      htmlFilename,
      sonarHtml,
      sonarReportsDir,
      config.cloud_storage,
      cwd,
    );
    if (sonarOutcome.cloudError && config.cloud_storage?.require_upload) {
      process.stderr.write(
        `[${CLI_NAME}] Cloud upload required but failed (SonarQube HTML): ${sonarOutcome.cloudError}\n`,
      );
      return 1;
    }
  }

  return 0;
}
