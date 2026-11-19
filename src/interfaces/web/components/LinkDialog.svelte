<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { fmt } from '../lib/i18n.js'
  import { linkNotStarted } from '../lib/risk.js'
  import type { LinkUi } from '../lib/state.js'
  import LinkStart from './LinkStart.svelte'
  import LinkView from './LinkView.svelte'
  import Modal from './Modal.svelte'

  let {
    controller,
    api,
    texts,
    id,
    link,
    needsNotice,
    onclose,
  }: {
    controller: Controller
    api: Api
    texts: WebTexts
    id: string
    link: LinkUi | undefined
    /** A new account: the legal notice comes first and the link starts when it is accepted. */
    needsNotice: boolean
    onclose: () => void
  } = $props()

  const t = $derived(texts.ui.link)
  let started = $state(false)
</script>

<Modal title={fmt(t.title, { account: id })} closeLabel={texts.ui.close} {onclose}>
  {#if needsNotice && !started && linkNotStarted(link)}
    <LinkStart
      {texts}
      idSuffix="dialog"
      onstart={() => {
        started = true
        void controller.startLink(id)
      }}
    />
  {:else}
    <LinkView {controller} {api} {texts} {id} {link} oncancel={onclose} />
  {/if}
</Modal>
