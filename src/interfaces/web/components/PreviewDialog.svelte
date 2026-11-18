<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Controller } from '../lib/controller.js'
  import { digestErrorText, errorText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import type { PreviewUi } from '../lib/state.js'
  import type { AccountView } from '../lib/types.js'
  import Modal from './Modal.svelte'

  let {
    controller,
    texts,
    account,
    preview,
    onclose,
  }: {
    controller: Controller
    texts: WebTexts
    account: AccountView
    preview: PreviewUi | undefined
    onclose: () => void
  } = $props()

  const t = $derived(texts.ui.preview)
  const current: PreviewUi = $derived(preview ?? { kind: 'idle' })
  const parts = $derived(current.view?.parts ?? [])
  let copied = $state(-1)

  async function copy(index: number) {
    try {
      await navigator.clipboard.writeText(parts[index] ?? '')
      copied = index
    } catch {
      copied = -1
    }
  }
</script>

<Modal title={fmt(t.title, { account: account.id })} closeLabel={texts.ui.close} {onclose}>
  <div aria-live="polite" class="stage">
    {#if current.kind === 'running' || current.kind === 'idle'}
      <p>{t.running}</p>
      <progress aria-label={t.running}></progress>
    {:else if current.kind === 'error'}
      <p class="note error" role="alert">{errorText(current.code, texts)}</p>
    {:else if current.kind === 'failed'}
      <p class="note error" role="alert">
        {t.failed}
        {current.error === undefined ? '' : digestErrorText(current.error, texts)}
      </p>
    {:else}
      <p class="note">{t.notSent}</p>
      {#if current.view?.generatedAt !== undefined}
        <p class="muted">
          {fmt(t.generatedAt, { when: formatDateTime(current.view.generatedAt, account.timezone, texts.locale) })}
        </p>
      {/if}
      {#if current.kind === 'empty'}
        <p>{t.empty}</p>
      {:else if current.view !== undefined}
        <p class="muted">
          {(current.view.failed ?? 0) > 0
            ? fmt(t.stats, { summarized: current.view.summarized ?? 0, failed: current.view.failed ?? 0 })
            : fmt(t.statsClean, { summarized: current.view.summarized ?? 0 })}
        </p>
      {/if}
      <!-- The parts are written from chats of third parties: they are shown as TEXT, never as markup. -->
      {#each parts as part, index (index)}
        <section class="part">
          <div class="part-head">
            <h3>{fmt(t.part, { n: index + 1, total: parts.length })}</h3>
            <button type="button" onclick={() => copy(index)}>{copied === index ? t.copied : t.copy}</button>
          </div>
          <div class="text">{part}</div>
        </section>
      {/each}
    {/if}
  </div>

  {#if current.kind !== 'running' && current.kind !== 'idle'}
    <div class="buttons">
      <button type="button" onclick={() => controller.startPreview(account.id)}>{t.generate}</button>
    </div>
  {/if}
</Modal>

<style>
  .stage {
    display: grid;
    gap: 0.75rem;
  }

  .stage p {
    margin: 0;
  }

  .part {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    display: grid;
    gap: 0.5rem;
  }

  .part-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  h3 {
    font-size: 0.95rem;
    color: var(--muted);
  }

  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
  }
</style>
