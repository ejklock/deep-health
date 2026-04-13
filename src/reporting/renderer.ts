import Handlebars from 'handlebars';

const registry = new Map<string, HandlebarsTemplateDelegate>();

export function render(templateSource: string, context: Record<string, unknown>): string {
  let compiled = registry.get(templateSource);
  if (!compiled) {
    compiled = Handlebars.compile(templateSource, { noEscape: true });
    registry.set(templateSource, compiled);
  }
  return compiled(context);
}
