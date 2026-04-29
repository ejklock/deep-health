export default `{{#if pipRuntimeVersion}}
  pip:
    runtime_version: '{{pipRuntimeVersion}}'{{#if pipImageSource}}
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
    # mode: 'docker'                   # optional — 'docker' (default) | 'local' | 'auto'
    # image: 'python:{{pipRuntimeVersion}}-slim'  # optional — override resolved Python image
{{/if}}
{{#if pipImageSource}}{{#unless pipRuntimeVersion}}
  pip:
    image_source: '{{pipImageSource}}'{{#if pipDockerfilePath}}
    dockerfile_path: '{{pipDockerfilePath}}'{{/if}}{{#if pipBuildContext}}
    build_context: '{{pipBuildContext}}'{{/if}}{{#if pipBuildArgs}}
    build_args:
{{#each pipBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if pipAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}
    # mode: 'docker'                   # optional — 'docker' (default) | 'local' | 'auto'
{{/unless}}{{/if}}`;
