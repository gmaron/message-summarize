<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText, linkErrorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { EMPTY_LINK, type LinkUi } from '../lib/state.js'

  // The QR, the sync and what to do when it fails: the body of the link dialog, also the QR step of the setup wizard.
  let {
    controller,
    api,
    texts,
    id,
    link,
    oncancel,
  }: {
    controller: Controller
    api: Api
    texts: WebTexts
    id: string
    link: LinkUi | undefined
    /** The user cancelled a link in progress (the link is cancelled before this is called). */
    oncancel: () => void
  } = $props()

  const t = $derived(texts.ui.link)
  const current = $derived(link ?? EMPTY_LINK)
  const running = $derived(['waitingQr', 'qr', 'syncing'].includes(current.phase))

  async function cancel() {
    await controller.cancelLink(id)
    oncancel()
  }
</script>

<div aria-live="polite" class="stage">
  {#if current.requestError !== null}
    <p class="note error" role="alert">{errorText(current.requestError, texts)}</p>
  {:else if current.phase === 'waitingQr' || current.phase === 'idle'}
    <p>{current.phase === 'idle' ? t.starting : t.waitingQr}</p>
    <progress aria-label={t.waitingQr}></progress>
  {:else if current.phase === 'qr'}
    <p>{t.scan}</p>
    <img class="qr" src={api.qrUrl(id, current.qrSeq)} alt={t.qrAlt} width="280" height="280" />
  {:else if current.phase === 'syncing'}
    <p>{current.sync?.done ? t.syncDone : t.connected}</p>
    {#if !current.sync?.done}
      {#if current.sync?.percent !== undefined}
        <progress aria-label={t.syncing} max="100" value={current.sync.percent}></progress>
        <p class="percent">{fmt(t.percent, { percent: current.sync.percent })}</p>
      {:else}
        <progress aria-label={t.syncing}></progress>
      {/if}
    {/if}
  {:else if current.phase === 'done'}
    <p class="note ok">{t.done}</p>
    {#if current.sync?.done}
      <p>{t.syncDone}</p>
    {/if}
  {:else if current.phase === 'failed'}
    <p class="note error" role="alert">{linkErrorText(current.error, texts)}</p>
  {/if}

  {#if current.sync !== null}
    <p class="counts">
      <span>{fmt(t.chats, { count: current.sync.chats })}</span>
      <span>{fmt(t.messages, { count: current.sync.messages })}</span>
    </p>
  {/if}
</div>

<div class="buttons">
  {#if running}
    <button type="button" class="danger" onclick={cancel}>{t.cancel}</button>
  {:else if current.phase === 'failed' || current.requestError !== null}
    <button type="button" class="primary" onclick={() => controller.startLink(id)}>{t.tryAgain}</button>
  {/if}
</div>

<style>
  .stage {
    display: grid;
    gap: 0.75rem;
    justify-items: center;
    text-align: center;
  }

  .stage > :global(*) {
    max-width: 100%;
  }

  .stage p {
    margin: 0;
  }

  .qr {
    background: #ffffff;
    border-radius: 8px;
    padding: 0.5rem;
    max-width: 100%;
    height: auto;
  }

  .counts {
    display: flex;
    gap: 1.25rem;
    margin: 0;
    color: var(--muted);
  }

  .buttons {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
  }
</style>
