<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { fmt } from '../lib/i18n.js'
  import type { LinkUi } from '../lib/state.js'
  import LinkView from './LinkView.svelte'
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
</script>

<Modal title={fmt(t.title, { account: id })} closeLabel={texts.ui.close} {onclose}>
  <LinkView {controller} {api} {texts} {id} {link} oncancel={onclose} />
</Modal>
