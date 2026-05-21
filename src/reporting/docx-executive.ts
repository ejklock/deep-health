import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  convertInchesToTwip,
} from 'docx';
import type { ExecutiveReportOptions } from '@core/types/report';
import { buildExecutiveReportContext } from './executive';

// ── colour palette for table headers ────────────────────────────────────────

const HEADER_FILL_BLUE = 'BDD7EE';   // fixed vulns — light blue
const HEADER_FILL_ORANGE = 'FCE4D6'; // pending vulns — light orange
const HEADER_FILL_GREY = 'EDEDED';   // evidence tables — light grey
const HEADER_TEXT_COLOR = '000000';

// ── border helper ────────────────────────────────────────────────────────────

const THIN_BORDER = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: '999999',
};

const cellBorders = {
  top: THIN_BORDER,
  bottom: THIN_BORDER,
  left: THIN_BORDER,
  right: THIN_BORDER,
};

// ── column width helpers ──────────────────────────────────────────────────────

function colWidths(percents: number[]) {
  const totalTwips = convertInchesToTwip(7.5);
  return percents.map((p) => Math.round(totalTwips * (p / 100)));
}

// ── cell builders ────────────────────────────────────────────────────────────

function headerCell(text: string, widthTwips: number, fillColor: string) {
  return new TableCell({
    width: { size: widthTwips, type: WidthType.DXA },
    shading: {
      type: ShadingType.SOLID,
      color: fillColor,
      fill: fillColor,
    },
    borders: cellBorders,
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({
            text,
            bold: true,
            color: HEADER_TEXT_COLOR,
            size: 18,
          }),
        ],
      }),
    ],
  });
}

function dataCell(text: string, widthTwips: number) {
  return new TableCell({
    width: { size: widthTwips, type: WidthType.DXA },
    borders: cellBorders,
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({
            text: text ?? '',
            size: 18,
          }),
        ],
      }),
    ],
  });
}

// ── shared row builders ───────────────────────────────────────────────────────

function buildHeaderRow(headers: string[], widths: number[], fillColor: string) {
  return new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => headerCell(h, widths[i]!, fillColor)),
  });
}

function buildDataRow(cells: string[], widths: number[]) {
  return new TableRow({
    children: cells.map((cell, i) => dataCell(cell, widths[i]!)),
  });
}

function buildVulnTable(headerRow: TableRow, dataRows: TableRow[]) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

// ── vuln field helpers ───────────────────────────────────────────────────────

function str(val: unknown, fallback = '') {
  const v = val ?? fallback;
  return String(v);
}

function strDash(val: unknown) {
  return str(val, '—');
}

function baseVulnCells(v: Record<string, unknown>) {
  const eco = str(v['ecoLabel']);
  const ghsa = strDash(v['ghsaId']);
  const cvss = strDash(v['cvss']);
  const pkg = str(v['package']);
  const affected = str(v['affectedVersions']);
  return [eco, ghsa, cvss, pkg, affected];
}

function evidenceVulnCells(ecoLabel: string, v: Record<string, unknown>) {
  const ghsa = strDash(v['ghsaId']);
  const cvss = strDash(v['cvss']);
  const pkg = str(v['package']);
  const affected = str(v['affectedVersions']);
  const status = str(v['statusPt']);
  const risk = strDash(v['risk']);
  return [ecoLabel, ghsa, cvss, pkg, affected, status, risk];
}

// ── table builders ───────────────────────────────────────────────────────────

/**
 * Fixed vulnerabilities table.
 * Columns: Ecosystem | GHSA | CVSS | Package | Affected Versions | Safe Version | Risk
 */
function buildFixedVulnsTable(fixedVulns: Record<string, unknown>[]) {
  const widths = colWidths([13, 14, 7, 20, 17, 13, 16]);
  const headers = ['Ecosystem', 'GHSA', 'CVSS', 'Package', 'Affected Versions', 'Safe Version', 'Risk'];
  const headerRow = buildHeaderRow(headers, widths, HEADER_FILL_BLUE);
  const dataRows = fixedVulns.map((v) =>
    buildDataRow([...baseVulnCells(v), strDash(v['safeVersion']), strDash(v['risk'])], widths),
  );
  return buildVulnTable(headerRow, dataRows);
}

/**
 * Pending vulnerabilities table.
 * Columns: Ecosystem | GHSA | CVSS | Package | Affected Versions | Reason
 */
function buildPendingVulnsTable(pendingVulns: Record<string, unknown>[]) {
  const widths = colWidths([13, 14, 7, 20, 17, 29]);
  const headers = ['Ecosystem', 'GHSA', 'CVSS', 'Package', 'Affected Versions', 'Reason'];
  const headerRow = buildHeaderRow(headers, widths, HEADER_FILL_ORANGE);
  const dataRows = pendingVulns.map((v) =>
    buildDataRow([...baseVulnCells(v), str(v['motivoPt'])], widths),
  );
  return buildVulnTable(headerRow, dataRows);
}

/**
 * Evidence table (per-ecosystem post-fix scan summary).
 * Columns: Ecosystem | GHSA | CVSS | Package | Affected Versions | Status | Risk
 */
function buildEvidenceTable(ecoLabel: string, vulnsAfter: Record<string, unknown>[]) {
  const widths = colWidths([13, 14, 7, 20, 17, 17, 12]);
  const headers = ['Ecosystem', 'GHSA', 'CVSS', 'Package', 'Affected Versions', 'Status', 'Risk'];
  const headerRow = buildHeaderRow(headers, widths, HEADER_FILL_GREY);
  const dataRows = vulnsAfter.map((v) => buildDataRow(evidenceVulnCells(ecoLabel, v), widths));
  return buildVulnTable(headerRow, dataRows);
}

// ── paragraph helpers ─────────────────────────────────────────────────────────

function heading1(text: string) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, bold: true, size: 32 })],
    spacing: { before: 200, after: 120 },
  });
}

function heading2(text: string) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, bold: true, size: 26 })],
    spacing: { before: 200, after: 100 },
  });
}

function bodyText(text: string) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20 })],
    spacing: { before: 80, after: 80 },
  });
}

function spacer() {
  return new Paragraph({ children: [new TextRun({ text: '' })] });
}

// ── locale string helpers ─────────────────────────────────────────────────────

function t(translations: Record<string, unknown>, key: string, fallback: string) {
  return String(translations?.[key] ?? fallback);
}

// ── sub-section builders ──────────────────────────────────────────────────────

type DocxNode = Paragraph | Table;

function buildMetadataLines(ctx: Record<string, unknown>, tr: Record<string, unknown>) {
  const labelClient = t(tr, 'label_client', 'Client');
  const labelProject = t(tr, 'label_project', 'Project');
  const labelPeriod = t(tr, 'label_period', 'Period');
  const lines: DocxNode[] = [
    bodyText(`${labelClient}: ${str(ctx['client'])}`),
    bodyText(`${labelProject}: ${str(ctx['project'])}`),
    bodyText(`${labelPeriod}: ${str(ctx['monthFull'])} ${str(ctx['year'])}`),
  ];
  if (ctx['hasBranch']) {
    lines.push(bodyText(`${t(tr, 'label_branch', 'Branch')}: ${str(ctx['branch'])}`));
  }
  if (ctx['scannerEngines']) {
    lines.push(bodyText(`${t(tr, 'label_scanners', 'Scanners')}: ${str(ctx['scannerEngines'])}`));
  }
  return lines;
}

function buildMetadataSection(ctx: Record<string, unknown>, tr: Record<string, unknown>) {
  const items: DocxNode[] = [heading1(t(tr, 'report_title', 'Security Report'))];
  items.push(...buildMetadataLines(ctx, tr));
  items.push(spacer());
  return items;
}

function buildResolutionSection(ctx: Record<string, unknown>, tr: Record<string, unknown>) {
  const items: DocxNode[] = [];

  const fixedVulns = (ctx['fixedVulns'] as Record<string, unknown>[]) ?? [];
  if (fixedVulns.length > 0) {
    items.push(heading2(t(tr, 'table_fixed_header', 'Fixed Vulnerabilities')));
    items.push(buildFixedVulnsTable(fixedVulns));
    items.push(spacer());
  }

  const pendingVulns = (ctx['pendingVulns'] as Record<string, unknown>[]) ?? [];
  if (pendingVulns.length > 0) {
    items.push(heading2(t(tr, 'table_pending_header', 'Pending Vulnerabilities')));
    items.push(buildPendingVulnsTable(pendingVulns));
    items.push(spacer());
  }

  return items;
}

function buildEvidenceBeforeSection(ctx: Record<string, unknown>, tr: Record<string, unknown>) {
  const items: DocxNode[] = [heading2(t(tr, 'section_evidence_before', 'Evidence — Pre-Fix Scan'))];
  const scanBeforeSummary = str(ctx['scanBeforeSummary']);
  if (scanBeforeSummary) {
    items.push(bodyText(scanBeforeSummary));
  }
  return items;
}

function appendEvidenceSection(section: Record<string, unknown>, ctx: Record<string, unknown>, items: DocxNode[]) {
  const fallbackLabel = String(section['reportLabel'] ?? section['id']);
  const evidenceTitle = str(section['evidenceTitle'], fallbackLabel);
  const vulnsAfter = (section['vulnsAfter'] as Record<string, unknown>[]) ?? [];
  const reportLabel = str(section['reportLabel'], str(section['id']));

  items.push(heading2(evidenceTitle));

  if (vulnsAfter.length > 0) {
    items.push(buildEvidenceTable(reportLabel, vulnsAfter));
    items.push(spacer());
    return;
  }

  const scanAfterSummary = str(ctx['scanAfterSummary']);
  if (scanAfterSummary) {
    items.push(bodyText(scanAfterSummary));
  }
}

function buildEvidenceAfterSection(ctx: Record<string, unknown>) {
  const items: DocxNode[] = [];
  const evidenceSections = (ctx['evidenceSections'] as Record<string, unknown>[]) ?? [];
  for (const section of evidenceSections) {
    appendEvidenceSection(section, ctx, items);
  }
  return items;
}

function buildPendingByPkgItems(pendingByPkg: Record<string, unknown>[], tr: Record<string, unknown>) {
  const items: DocxNode[] = [bodyText(t(tr, 'pending_needs_action_intro', 'The following packages require manual attention:'))];
  for (const pkg of pendingByPkg) {
    const line = `• ${str(pkg['package'])} ${str(pkg['currentVersion'])} — ${str(pkg['motivoPt'])} (${str(pkg['risk'])}${str(pkg['cvssDisplay'])})`;
    items.push(bodyText(line));
  }
  return items;
}

function buildSummarySection(ctx: Record<string, unknown>, tr: Record<string, unknown>) {
  const items: DocxNode[] = [heading2(t(tr, 'section_summary', 'Summary'))];

  const pendingByPkg = (ctx['pendingByPkg'] as Record<string, unknown>[]) ?? [];
  if (pendingByPkg.length > 0) {
    items.push(...buildPendingByPkgItems(pendingByPkg, tr));
  } else if (ctx['allFixed']) {
    items.push(bodyText(t(tr, 'all_fixed', 'All vulnerabilities have been resolved.')));
  }

  return items;
}

// ── document children builder ─────────────────────────────────────────────────

function buildDocumentChildren(ctx: Record<string, unknown>) {
  const tr = ctx['t'] as Record<string, unknown>;

  const metadata = buildMetadataSection(ctx, tr);

  if (ctx['noVulns']) {
    return [...metadata, bodyText(t(tr, 'no_vulns', 'No vulnerabilities found.'))];
  }

  return [
    ...metadata,
    ...buildResolutionSection(ctx, tr),
    ...buildEvidenceBeforeSection(ctx, tr),
    ...buildEvidenceAfterSection(ctx),
    ...buildSummarySection(ctx, tr),
  ];
}

// ── main generator ────────────────────────────────────────────────────────────

/**
 * Generate an executive security report as a DOCX Buffer.
 * Accepts the same ExecutiveReportOptions as generateExecutiveReport().
 * Returns a Promise<Buffer> since docx v8+ Packer.toBuffer() is async.
 */
export async function generateExecutiveReportDocx(opts: ExecutiveReportOptions): Promise<Buffer> {
  const ctx = buildExecutiveReportContext(opts);
  const children = buildDocumentChildren(ctx);

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

// ── filename helper ───────────────────────────────────────────────────────────

function monthName(date: Date) {
  return date.toLocaleString('en-US', { month: 'long' });
}

export function executiveReportDocxFilename(client: string, project: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `[${client} ${project}] Security Report - ${year}-${month} - ${monthName(now)}.docx`;
}
