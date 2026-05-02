export default `{{#if npmLanguageVersion}}
  npm:
    language_version: '{{npmLanguageVersion}}'{{#if npmImageSource}}
    image_source: '{{npmImageSource}}'{{#if npmDockerfilePath}}
    dockerfile_path: '{{npmDockerfilePath}}'{{/if}}{{#if npmBuildContext}}
    build_context: '{{npmBuildContext}}'{{/if}}{{#if npmBuildArgs}}
    build_args:
{{#each npmBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if npmAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}{{else}}
    # image_source: 'pull'             # optional — 'pull' (default) | 'dockerfile'
    # dockerfile_path: 'Dockerfile'    # required when image_source='dockerfile'{{/if}}
    # image: 'node:{{npmLanguageVersion}}'  # optional — override resolved Node image
{{/if}}
{{#if npmImageSource}}{{#unless npmLanguageVersion}}
  npm:
    image_source: '{{npmImageSource}}'{{#if npmDockerfilePath}}
    dockerfile_path: '{{npmDockerfilePath}}'{{/if}}{{#if npmBuildContext}}
    build_context: '{{npmBuildContext}}'{{/if}}{{#if npmBuildArgs}}
    build_args:
{{#each npmBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if npmAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}
{{/unless}}{{/if}}`;
