export default `{{#if npmRuntimeVersion}}
  npm:
    runtime_version: '{{npmRuntimeVersion}}'{{#if npmImageSource}}
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
    # mode: 'docker'                   # optional — 'docker' (default) | 'local' | 'auto'
    # image: 'node:{{npmRuntimeVersion}}'  # optional — override resolved Node image
{{/if}}
{{#if npmImageSource}}{{#unless npmRuntimeVersion}}
  npm:
    image_source: '{{npmImageSource}}'{{#if npmDockerfilePath}}
    dockerfile_path: '{{npmDockerfilePath}}'{{/if}}{{#if npmBuildContext}}
    build_context: '{{npmBuildContext}}'{{/if}}{{#if npmBuildArgs}}
    build_args:
{{#each npmBuildArgs}}      {{key}}: '{{value}}'
{{/each}}{{/if}}{{#if npmAllowBuildContextEscape}}
    allow_build_context_escape: true{{else}}
    # allow_build_context_escape: false # optional — allow build_context outside project boundary ⚠{{/if}}
    # mode: 'docker'                   # optional — 'docker' (default) | 'local' | 'auto'
{{/unless}}{{/if}}`;
