export default `\
{{t.title}}
**{{t.label_date}}:** {{date}}
**{{t.label_environment}}:** {{environment}}
{{#if hasBranch}}**{{t.label_branch}}:** {{branch}}
{{/if}}{{#if scannerEngines}}**{{t.label_scanners}}:** {{scannerEngines}}
{{/if}}
## {{t.section_vulns}}
- **{{t.label_total}}:** {{totalVulns}}
{{#each ecosystemSections}}- **{{reportLabel}} (auto-safe/breaking/manual):** {{eco.auto_safe}}/{{eco.breaking}}/{{eco.manual}}
{{/each}}

## {{t.section_fixes}}

{{#each ecosystemSections}}
{{ecosystemHeader}}
{{#if updatedPackages}}
{{#each updatedPackages}}- {{this}}
{{/each}}
{{else}}
- {{../t.no_packages_updated}}
{{/if}}

{{/each}}

## {{t.section_validation}}
{{#each ecosystemSections}}
{{#if hasValidations}}
{{ecosystemHeader}}
{{#each validationEntries}}- **{{name}}:** {{statusLabel}}
{{#if hasDetail}}  {{detail}}
{{/if}}{{/each}}
{{/if}}
{{/each}}

{{#if pendingItems}}
## {{t.section_pending}}

{{#if breakingPkgs}}
### {{t.breaking_title}}
{{#each breakingPkgs}}- {{this}}
  {{../t.breaking_authorize}}
{{/each}}

{{/if}}
{{#if manualPkgs}}
### {{t.no_safe_version_title}}
{{#each manualPkgs}}- {{this}}
{{/each}}

{{/if}}
{{/if}}

{{#if sonarSection.present}}
{{t.sonarqube_section}}

{{#if sonarSection.skipped}}
{{t.sonarqube_skipped}}
{{else if sonarSection.warning}}
{{sonarSection.warning}}
{{else}}
{{sonarSection.qualityGate}}

{{#if sonarSection.metrics}}
{{t.sonarqube_metrics}}
{{#each sonarSection.metrics}}- **{{key}}:** {{value}}
{{/each}}
{{/if}}

{{#if sonarSection.noIssues}}
{{t.sonarqube_no_issues}}
{{else if sonarSection.affectedFiles}}
{{t.sonarqube_affected_files}}
{{#each sonarSection.affectedFiles}}- {{this}}
{{/each}}
{{/if}}
{{/if}}
{{/if}}

{{#if advisorSection.present}}
{{t.advisors_section}}

{{#each advisorSection.ecosystems}}
{{#each advisors}}
{{header}}

**Status:** {{statusLabel}}
{{#if hasOutput}}
{{outputBlock}}
{{/if}}

{{/each}}
{{/each}}
{{/if}}
`;
