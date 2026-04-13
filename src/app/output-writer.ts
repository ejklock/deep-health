import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScanResultJson } from "@core/types/scan.js";

/**
 * Format a scan result as a human-readable markdown summary.
 */
export function formatScanSummary(scan: ScanResultJson): string {
  const lines: string[] = [
    `## OSV Scan Report — ${new Date().toISOString().split("T")[0]}`,
    `**Environment:** ${scan.environment}`,
    "",
  ];

  for (const [id, eco] of Object.entries(scan.ecosystems)) {
    lines.push(
      `### ${id}`,
      `- Total: ${eco.vulnerabilities_total}`,
      `- Auto-safe: ${eco.auto_safe}`,
      `- Breaking: ${eco.breaking}`,
      `- Manual: ${eco.manual}`,
      "",
    );
  }

  if (scan.error) {
    lines.push(`**Warning:** ${scan.error}`);
  }

  return lines.join("\n");
}

/**
 * Write content to a file path, or stdout if no path is given.
 */
export async function writeOutput(
  content: string,
  outputPath?: string,
): Promise<void> {
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf-8");
  } else {
    process.stdout.write(content + "\n");
  }
}
