<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText, linkErrorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { EMPTY_LINK, type LinkUi } from '../lib/state.js'
  import Modal from './Modal.svelte'

  let {
    controller,
    api,
    texts,
    id,
    link,
    onclose,
  }: {
    controller: Controller
    api: Api
    texts: WebTexts
    id: string
    link: LinkUi | undefined
    onclose: () => void
  } = $props()

  const t = $derived(texts.ui.link)
  const current = $derived(link ?? EMPTY_LINK)
  const running = $derived(['waitingQr', 'qr', 'syncing'].includes(current.phase))

  async function cancel() {
    await controller.cancelLink(id)
    onclose()
  }
</script>

<Modal title={fmt(t.title, { account: id })} closeLabel={texts.ui.close} {onclose}>
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
</Modal>

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
