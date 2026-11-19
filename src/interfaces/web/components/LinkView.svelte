<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText, linkErrorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { EMPTY_LINK, type LinkUi } from '../lib/state.js'

  // The QR with what to do with it, then the sync, then what went wrong if something did. Used by the page that links an
  // account, the page that adds one and the setup wizard. `done` is drawn when the account is linked and synced.
  let {
    controller,
    api,
    texts,
    id,
    link,
    oncancel,
    done,
  }: {
    controller: Controller
    api: Api
    texts: WebTexts
    id: string
    link: LinkUi | undefined
    /** The user cancelled a link in progress (the link is cancelled before this is called). */
    oncancel: () => void
    done?: Snippet
  } = $props()

  const t = $derived(texts.ui.link)
  const current = $derived(link ?? EMPTY_LINK)
  const running = $derived(['waitingQr', 'qr', 'syncing'].includes(current.phase))
  const showQr = $derived(current.requestError === null && ['idle', 'waitingQr', 'qr'].includes(current.phase))
  const progress = $derived(
    current.sync === null
      ? ''
      : [
          current.sync.percent === undefined ? null : fmt(t.percent, { percent: current.sync.percent }),
          fmt(t.chats, { count: current.sync.chats }),
          fmt(t.messages, { count: current.sync.messages }),
        ]
          .filter((part) => part !== null)
          .join(texts.ui.text.separator),
  )

  /** What a screen reader hears as the stages go by: one region from the start, only its text changes. */
  const announcement = $derived.by(() => {
    if (current.requestError !== null || current.phase === 'failed') return ''
    switch (current.phase) {
      case 'idle':
        return t.starting
      case 'waitingQr':
        return t.waitingQr
      case 'qr':
        return t.qrAlt
      case 'syncing':
        return current.sync?.done ? t.syncDone : `${t.syncTitle}${texts.ui.text.separator}${progress}`
      default:
        return `${t.syncDone}${texts.ui.text.separator}${t.doneText}`
    }
  })

  async function cancel() {
    await controller.cancelLink(id)
    oncancel()
  }
</script>

<div class="stack">
  <div class="sr" role="status" aria-live="polite">{announcement}</div>
  {#if current.requestError !== null}
    <div class="notice bad" role="alert">{errorText(current.requestError, texts)}</div>
  {:else if current.phase === 'failed'}
    <div class="notice bad" role="alert">{linkErrorText(current.error, texts)}</div>
  {:else if showQr}
    <div class="qr-wrap">
      {#if current.phase === 'qr'}
        <img class="qr" src={api.qrUrl(id, current.qrSeq)} alt={t.qrAlt} width="232" height="232" />
      {:else}
        <div class="qr-placeholder">
          <div class="stack-sm">
            <progress class="bar" aria-label={t.waitingQr}></progress>
            <span>{current.phase === 'idle' ? t.starting : t.waitingQr}</span>
          </div>
        </div>
      {/if}
      <div class="stack">
        <ol class="howto">
          <li>{fmt(t.first, { account: id })}</li>
          <li>{t.second}</li>
          <li>{t.third}</li>
        </ol>
        <p class="small muted">{t.renews}</p>
      </div>
    </div>
  {:else if current.phase === 'syncing'}
    <div class="panel measure">
      <h2>{current.sync?.done ? t.syncDone : t.syncTitle}</h2>
      <div class="progress">
        {#if current.sync?.percent !== undefined}
          <progress class="bar" aria-label={t.syncing} max="100" value={current.sync.percent}></progress>
        {:else}
          <progress class="bar" aria-label={t.syncing}></progress>
        {/if}
        <span class="small muted num">{progress}</span>
      </div>
      <p class="small muted">{t.leaveNote}</p>
    </div>
  {:else if current.phase === 'done'}
    <div class="panel measure">
      <h2>{t.syncDone}</h2>
      {#if progress !== ''}<span class="small muted num">{progress}</span>{/if}
      <p>{t.doneText}</p>
      {#if done !== undefined}<div class="cluster">{@render done()}</div>{/if}
    </div>
  {/if}

  <div class="cluster">
    {#if running}
      <button type="button" class="btn danger" onclick={cancel}>{t.cancel}</button>
    {:else if current.phase === 'failed' || current.requestError !== null}
      <button type="button" class="btn primary" onclick={() => controller.startLink(id)}>{t.tryAgain}</button>
    {/if}
  </div>
</div>
