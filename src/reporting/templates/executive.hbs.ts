export default `\
{{t.label_client}}: {{client}}
{{t.label_project}}: {{project}}
{{t.label_period}}: {{monthFull}} {{year}}

{{t.section_task}}

{{t.task_title}}

{{t.task_description}}

{{t.section_resolution}}

{{#if noVulns}}
{{t.no_vulns}}
{{else}}
{{#if fixedVulns}}
{{t.found_and_fixed}}

{{t.table_fixed_header}}
{{#each fixedVulns}}| {{ecoLabel}} | {{ghsaLink}} | {{cvss}} | {{package}} | {{currentVersion}} | {{safeVersion}} | {{risk}} |
{{/each}}{{/if}}
{{#if pendingVulns}}
{{t.pending_intro}}

{{t.table_pending_header}}
{{#each pendingVulns}}| {{ecoLabel}} | {{ghsaLink}} | {{cvss}} | {{package}} | {{currentVersion}} | {{motivoPt}} |
{{/each}}{{/if}}
{{/if}}

---

{{t.section_evidence_before}}

{{t.table_before_header}}
{{#each allVulnsBefore}}| {{ecoLabel}} | {{ghsaId}} | {{cvss}} | {{package}} | {{currentVersion}} | {{risk}} |
{{/each}}
{{scanBeforeSummary}}

---

{{t.section_evidence_after}}

{{#each evidenceSections}}
{{#if hasVulns}}
{{evidenceTitle}}

{{../t.table_after_header}}
{{#each vulnsAfter}}| {{../reportLabel}} | {{ghsaId}} | {{cvss}} | {{package}} | {{statusPt}} | {{risk}} |
{{/each}}
{{/if}}
{{/each}}
{{scanAfterSummary}}

{{#each evidenceSections}}
{{#if showValidation}}
{{validationVerified}}

{{/if}}
{{/each}}

---

{{t.section_summary}}

{{#if noVulns}}
{{t.no_vulns}}
{{else if allFixed}}
{{t.all_fixed}}
{{else if pendingByPkg}}
{{t.pending_needs_action_intro}}

{{#each pendingByPkg}}- {{package}} ({{currentVersion}}): {{motivoPt}}. {{riskLabel}}: {{risk}}{{cvssDisplay}}.
{{/each}}
{{else}}
{{t.pending_manual}}
{{/if}}

{{#if sonarSection.present}}
---

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
{{/if}}
{{/if}}
`;
