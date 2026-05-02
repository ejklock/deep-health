export default `{{#if composerLanguageVersion}}
  composer:
    language_version: '{{composerLanguageVersion}}'{{#if composerImageSource}}
    image_source: '{{composerImageSource}}'{{#if composerDockerfilePath}}
    dockerfile_path: '{{composerDockerfilePath}}'{{/if}}{{#if composerBuildContext}}
    build_context: '{{composerBuildContext}}'{{/if}}{{#if composerBuildArgs}}
    build_args:
{{#each composerBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if composerAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}{{else}}
    # image_source: 'pull'             # optional — 'pull' (default) | 'dockerfile'
    # dockerfile_path: 'Dockerfile'    # required when image_source='dockerfile'{{/if}}
    # image: 'php:{{composerLanguageVersion}}-cli'  # optional — override resolved PHP image
{{/if}}
{{#if composerImageSource}}{{#unless composerLanguageVersion}}
  composer:
    image_source: '{{composerImageSource}}'{{#if composerDockerfilePath}}
    dockerfile_path: '{{composerDockerfilePath}}'{{/if}}{{#if composerBuildContext}}
    build_context: '{{composerBuildContext}}'{{/if}}{{#if composerBuildArgs}}
    build_args:
{{#each composerBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if composerAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}
{{/unless}}{{/if}}`;
