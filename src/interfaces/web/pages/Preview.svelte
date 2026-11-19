<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import DigestThread from '../components/DigestThread.svelte'
  import Icon from '../components/Icon.svelte'
  import { accountActions } from '../lib/accounts.js'
  import type { Controller } from '../lib/controller.js'
  import { digestErrorText, errorText } from '../lib/digest.js'
  import { dayChip, formatDateTime, formatTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import { hrefOf } from '../lib/router.js'
  import type { AppState, PreviewUi } from '../lib/state.js'
  import type { AccountView } from '../lib/types.js'

  // Vista previa: the digest as it would be sent now, in a bubble that says it was not sent. Nothing moves until it is sent.
  let {
    app,
    texts,
    controller,
    account,
    now,
  }: { app: AppState; texts: WebTexts; controller: Controller; account: AccountView; now: number } = $props()

  const ui = $derived(texts.ui)
  const t = $derived(texts.ui.preview)
  const id = $derived(account.id)
  const current: PreviewUi = $derived(app.previews[id] ?? { kind: 'idle' })
  const parts = $derived(current.view?.parts ?? [])
  const actions = $derived(accountActions(account))

  // Asking for the page asks for a preview, as opening the old window did.
  $effect(() => {
    const account = id
    untrack(() => void controller.startPreview(account))
  })

  let copied = $state(-1)
  async function copy(index: number) {
    try {
      await navigator.clipboard.writeText(parts[index] ?? '')
      copied = index
    } catch {
      copied = -1
    }
  }

  async function send() {
    await controller.digestNow(id)
    location.hash = hrefOf({ name: 'account', id, tab: 'resumen' })
  }

  const generated = $derived(current.view?.generatedAt ?? now)
  const working = $derived(current.kind === 'running' || current.kind === 'idle')
  const stats = $derived.by(() => {
    const view = current.view
    if (view === undefined || current.kind === 'empty') return null
    return (view.failed ?? 0) > 0
      ? fmt(t.stats, { summarized: view.summarized ?? 0, failed: view.failed ?? 0 })
      : fmt(t.statsClean, { summarized: view.summarized ?? 0 })
  })
</script>

<div class="page-inner">
  <div class="crumb">
    <a href={hrefOf({ name: 'account', id, tab: 'resumen' })}><Icon name="back" />{id}</a>
  </div>
  <div class="head"><h1>{t.title}</h1></div>

  <!-- One live region from the start: only its text changes while the preview is made. -->
  <div class="sr" role="status" aria-live="polite">{working ? t.running : ''}</div>
  {#if working}
    <div class="panel measure">
      <h2>{t.running}</h2>
      <div class="progress"><progress class="bar" aria-label={t.running}></progress></div>
      <div class="stack-sm">
        <div class="skeleton w-55"></div>
        <div class="skeleton w-92"></div>
        <div class="skeleton w-70"></div>
      </div>
    </div>
  {:else if current.kind === 'error'}
    <div class="notice bad measure" role="alert">{errorText(current.code, texts)}</div>
  {:else if current.kind === 'failed'}
    <div class="notice bad measure" role="alert">
      {t.failed}
      {current.error === undefined ? '' : digestErrorText(current.error, texts)}
    </div>
  {:else}
    <div class="stack">
      <div class="notice info measure">{t.notSent}</div>
      {#if current.kind === 'empty'}
        <p class="measure">{t.empty}</p>
      {:else}
        <!-- The parts are written from chats of third parties: DigestThread draws them as text, never as markup. -->
        <DigestThread {texts} {parts} day={dayChip(generated, account.timezone, texts.locale, now)} time={formatTime(generated, account.timezone, texts.locale)} status="draft" />
        <div class="cluster">
          {#each parts as _, index (index)}
            <button type="button" class="btn sm" onclick={() => copy(index)}>
              {parts.length > 1 ? fmt(texts.ui.text.labelled, { label: fmt(texts.ui.bubble.part, { n: index + 1, total: parts.length }), value: copied === index ? t.copied : t.copy }) : copied === index ? t.copied : t.copy}
            </button>
          {/each}
        </div>
        <p class="small muted">
          {fmt(t.generatedAt, { when: formatDateTime(generated, account.timezone, texts.locale) })}
          {#if stats !== null}{texts.ui.text.separator}{stats}{/if}
        </p>
      {/if}
    </div>
  {/if}

  {#if !working && current.kind === 'done'}
    <p class="small muted measure">{t.sendNote}</p>
  {/if}
  {#if !working}
    <div class="cluster">
      {#if current.kind === 'done'}
        <button type="button" class="btn primary" disabled={!actions.digest} onclick={send}><Icon name="send" />{t.send}</button>
        <a class="btn" href={hrefOf({ name: 'prompt', id })}>{t.adjustPrompt}</a>
      {:else}
        <button type="button" class="btn" onclick={() => controller.startPreview(id)}>{t.generate}</button>
      {/if}
      <a class="btn quiet" href={hrefOf({ name: 'account', id, tab: 'resumen' })}>{ui.close}</a>
    </div>
  {/if}
</div>
