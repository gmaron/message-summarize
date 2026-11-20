<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Language } from '../lib/types.js'

  // "Español | English": switches the page at once. A browser is often in English on a Spanish computer, so the language it
  // asks for is never the only way to choose one. Each name is in its own language, whatever the page says now.
  let { texts, current, onchoose }: { texts: WebTexts; current: Language; onchoose: (language: Language) => void } = $props()

  const NAMES: Readonly<Record<Language, string>> = { es: 'Español', en: 'English' }
</script>

<div class="chips" role="group" aria-label={texts.ui.languageLabel}>
  {#each ['es', 'en'] as const as language (language)}
    <button type="button" class="chip" lang={language} aria-pressed={current === language} onclick={() => onchoose(language)}>
      {NAMES[language]}
    </button>
  {/each}
</div>
