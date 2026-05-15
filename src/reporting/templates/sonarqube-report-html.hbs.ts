export default `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SonarQube Report — {{project}}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f5f6fa; color: #1a1a2e; }
  .page { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
  header { background: #0e4f8b; color: #fff; border-radius: 8px; padding: 1.5rem 2rem; margin-bottom: 1.5rem; }
  header h1 { margin: 0 0 .25rem; font-size: 1.4rem; font-weight: 700; }
  header .meta { font-size: .85rem; opacity: .85; }
  header .meta span { margin-right: 1.5rem; }
  .card { background: #fff; border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .card h2 { margin: 0 0 1rem; font-size: 1rem; font-weight: 600; color: #0e4f8b; border-bottom: 1px solid #e8eaf0; padding-bottom: .5rem; }
  .qg-badge { display: inline-block; padding: .35rem .9rem; border-radius: 20px; font-weight: 700; font-size: 1rem; letter-spacing: .02em; }
  .qg-ok { background: #d4edda; color: #155724; }
  .qg-error { background: #f8d7da; color: #721c24; }
  .qg-warn { background: #fff3cd; color: #856404; }
  .conditions table, .metrics table, .issues table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  .conditions th, .metrics th, .issues th { text-align: left; padding: .4rem .6rem; background: #f0f2f8; color: #444; font-weight: 600; border-bottom: 2px solid #dde0ec; }
  .conditions td, .metrics td, .issues td { padding: .4rem .6rem; border-bottom: 1px solid #eef0f8; vertical-align: top; }
  .conditions tr:last-child td, .metrics tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: .15rem .45rem; border-radius: 4px; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .sev-blocker, .sev-critical { background: #fde8e8; color: #9b1c1c; }
  .sev-major { background: #fef3c7; color: #92400e; }
  .sev-minor { background: #fefce8; color: #713f12; }
  .sev-info { background: #e0f2fe; color: #075985; }
  .sev-unknown { background: #f3f4f6; color: #374151; }
  .status-ok { color: #155724; font-weight: 600; }
  .status-error { color: #721c24; font-weight: 600; }
  .file-group { margin-bottom: 1.25rem; }
  .file-group:last-child { margin-bottom: 0; }
  .file-header { font-size: .8rem; font-family: "SFMono-Regular", Consolas, monospace; background: #f0f2f8; padding: .3rem .6rem; border-radius: 4px; margin-bottom: .5rem; color: #334155; word-break: break-all; }
  .issue-row td:first-child { width: 90px; }
  .issue-row td:nth-child(2) { font-family: monospace; font-size: .8rem; color: #6b7280; width: 200px; }
  .issue-row td:nth-child(3) { width: 60px; color: #6b7280; font-size: .8rem; }
  .issue-row td:last-child { color: #374151; }
  .empty-notice { color: #6b7280; font-style: italic; font-size: .875rem; }
  .warning-box { background: #fff3cd; border-left: 4px solid #f59e0b; padding: .75rem 1rem; border-radius: 4px; color: #78350f; font-size: .875rem; }
  footer { text-align: center; font-size: .75rem; color: #9ca3af; margin-top: 2rem; padding-bottom: 2rem; }
</style>
</head>
<body>
<div class="page">
  <header>
    <h1>SonarQube Report — {{project}}</h1>
    <div class="meta">
      <span>{{periodLabel}}</span>
      {{#if client}}<span>{{clientLabel}}: {{client}}</span>{{/if}}
      {{#if exportedAt}}<span>{{exportedAtLabel}}: {{exportedAt}}</span>{{/if}}
    </div>
  </header>

  {{#if warning}}
  <div class="card">
    <div class="warning-box">⚠️ {{warning}}</div>
  </div>
  {{else}}

  {{#if qualityGateStatus}}
  <div class="card">
    <h2>{{qualityGateLabel}}</h2>
    <span class="qg-badge {{qualityGateBadgeClass}}">{{qualityGateStatus}}</span>

    {{#if hasConditions}}
    <div class="conditions" style="margin-top:1rem">
      <table>
        <thead><tr><th></th><th>Metric</th><th>Actual</th><th>Threshold</th><th>Comparator</th></tr></thead>
        <tbody>
        {{#each conditions}}
          <tr>
            <td>{{statusIcon}}</td>
            <td>{{metricKey}}</td>
            <td class="{{#if isOk}}status-ok{{else}}status-error{{/if}}">{{actualValue}}</td>
            <td>{{errorThreshold}}</td>
            <td>{{comparator}}</td>
          </tr>
        {{/each}}
        </tbody>
      </table>
    </div>
    {{/if}}
  </div>
  {{/if}}

  {{#if metrics}}
  <div class="card">
    <h2>{{metricsLabel}}</h2>
    <div class="metrics">
      <table>
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
        {{#each metrics}}
          <tr><td>{{key}}</td><td>{{value}}</td></tr>
        {{/each}}
        </tbody>
      </table>
    </div>
  </div>
  {{/if}}

  <div class="card">
    <h2>{{issuesLabel}}{{#if issueCountSuffix}} <span style="font-weight:400;color:#6b7280;font-size:.875rem">{{issueCountSuffix}}</span>{{/if}}</h2>
    {{#if noIssues}}
    <p class="empty-notice">{{noIssuesLabel}}</p>
    {{else if issuesByFile}}
    {{#each issuesByFile}}
    <div class="file-group">
      <div class="file-header">📄 {{file}}</div>
      <table class="issues">
        <thead><tr><th>Severity</th><th>Rule</th><th>Line</th><th>Message</th></tr></thead>
        <tbody>
        {{#each issues}}
          <tr class="issue-row">
            <td><span class="badge sev-{{severityClass}}">{{severity}}</span></td>
            <td>{{rule}}</td>
            <td>{{line}}</td>
            <td>{{message}}</td>
          </tr>
        {{/each}}
        </tbody>
      </table>
    </div>
    {{/each}}
    {{/if}}
  </div>

  {{/if}}

  <footer>Generated by {{cliName}} · {{exportedAt}}</footer>
</div>
</body>
</html>
`;
