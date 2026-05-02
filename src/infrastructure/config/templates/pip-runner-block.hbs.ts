export default `{{#if pipLanguageVersion}}
  pip:
    language_version: '{{pipLanguageVersion}}'{{#if pipImageSource}}
    image_source: '{{pipImageSource}}'{{#if pipDockerfilePath}}
    dockerfile_path: '{{pipDockerfilePath}}'{{/if}}{{#if pipBuildContext}}
    build_context: '{{pipBuildContext}}'{{/if}}{{#if pipBuildArgs}}
    build_args:
{{#each pipBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if pipAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}{{else}}
    # image_source: 'pull'             # optional — 'pull' (default) | 'dockerfile'
    # dockerfile_path: 'Dockerfile'    # required when image_source='dockerfile'{{/if}}
    # image: 'python:{{pipLanguageVersion}}-slim'  # optional — override resolved Python image
{{/if}}
{{#if pipImageSource}}{{#unless pipLanguageVersion}}
  pip:
    image_source: '{{pipImageSource}}'{{#if pipDockerfilePath}}
    dockerfile_path: '{{pipDockerfilePath}}'{{/if}}{{#if pipBuildContext}}
    build_context: '{{pipBuildContext}}'{{/if}}{{#if pipBuildArgs}}
    build_args:
{{#each pipBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if pipAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}
{{/unless}}{{/if}}`;
