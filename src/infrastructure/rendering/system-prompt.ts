import type { SystemPromptRenderer } from '../../application/ports/rendering.js'
import type { Catalog } from '../i18n/catalog.js'

export function createSystemPromptRenderer(catalog: Catalog): SystemPromptRenderer {
  return {
    defaultTemplate: catalog.defaultSystemPrompt,
    render(template, ownerName) {
      const name = ownerName?.trim() ? ownerName : catalog.promptOwnerName
      return (
        (template ?? catalog.defaultSystemPrompt)
          // Comments are notes for the editor. They go first, so a name cannot open or close one.
          .replace(/<!--[\s\S]*?-->/g, '')
          // A function, so "$&" and similar in a name are not interpreted.
          .replaceAll('{{name}}', () => name)
          .trim()
      )
    },
  }
}
