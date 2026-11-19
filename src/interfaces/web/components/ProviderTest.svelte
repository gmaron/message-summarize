<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import type { ProviderTestResult } from '../lib/types.js'

  // "Test connection" (RF-41): a real call, made only when this button is clicked.
  let {
    api,
    texts,
    body,
    blocked,
  }: {
    api: Api
    texts: WebTexts
    /** What to test; changing it forgets the last result. */
    body: { provider: string; options: Record<string, string>; consent?: boolean }
    /** Why the test cannot run now (the consent is not ticked, a field is missing): said instead of running. */
    blocked: boolean
  } = $props()

  const t = $derived(texts.ui.disclosure.test)
  let running = $state(false)
  let result: ProviderTestResult | null = $state.raw(null)
  let failure: string | null = $state(null)

  $effect(() => {
    // A change of what is tested makes the last result stale.
    JSON.stringify(body)
    result = null
    failure = null
  })

  async function run() {
    running = true
    result = null
    failure = null
    try {
      result = await api.testProvider(body)
    } catch (error) {
      failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      running = false
    }
  }
</script>

<div class="stack-sm">
  <div><button type="button" class="btn" onclick={run} disabled={running || blocked}>{t.button}</button></div>
  <p class="muted small">{t.note}</p>
  <div aria-live="polite">
    {#if running}
      <p class="notice info" role="status">{t.running}</p>
    {:else if result !== null && result.ok}
      <p class="notice ok" role="status">{fmt(t.ok, { ms: result.ms })}</p>
    {:else if result !== null}
      <p class="notice bad" role="alert">{t.errors[result.error] ?? texts.errors.internal}</p>
    {:else if failure !== null}
      <p class="notice bad" role="alert">{failure}</p>
    {/if}
  </div>
</div>
