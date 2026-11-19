<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import Icon from '../components/Icon.svelte'
  import LinkStart from '../components/LinkStart.svelte'
  import LinkView from '../components/LinkView.svelte'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { fmt } from '../lib/i18n.js'
  import { linkNeedsNotice, linkNotStarted } from '../lib/risk.js'
  import { hrefOf } from '../lib/router.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView } from '../lib/types.js'

  // Vincular / Volver a vincular: the QR to scan with the phone, then the sync of the history.
  let {
    app,
    api,
    texts,
    controller,
    account,
  }: { app: AppState; api: Api; texts: WebTexts; controller: Controller; account: AccountView } = $props()

  const t = $derived(texts.ui.link)
  const id = $derived(account.id)
  // A new account starts linking when the legal notice is accepted (LinkStart); linking again starts at once.
  const needsNotice = untrack(() => linkNeedsNotice(account))
  let started = $state(false)
  // Opening the page starts the link (or picks up one that is already going on), as opening the old window did.
  $effect(() => {
    const account = id
    untrack(() => {
      if (app.accounts?.find((row) => row.id === account)?.state === 'linking') void controller.restoreLink(account)
      else if (!needsNotice) void controller.startLink(account)
    })
  })
  // Said once, when the page opens: the account stops being blocked while it is linked, and the title must not change.
  const again = untrack(() => account.state === 'blocked')
</script>

<div class="page-inner">
  <div class="crumb">
    <a href={hrefOf({ name: 'account', id, tab: 'resumen' })}><Icon name="back" />{id}</a>
  </div>
  <div class="head"><h1>{fmt(again ? t.relinkTitle : t.title, { account: id })}</h1></div>
  {#if needsNotice && !started && linkNotStarted(app.links[id])}
    <LinkStart
      {texts}
      idSuffix="link"
      onstart={() => {
        started = true
        void controller.startLink(id)
      }}
    />
  {:else}
  <LinkView {controller} {api} {texts} {id} link={app.links[id]} oncancel={() => (location.hash = hrefOf({ name: 'account', id, tab: 'resumen' }))}>
    {#snippet done()}
      <a class="btn primary" href={hrefOf({ name: 'account', id, tab: 'resumen' })}>{fmt(t.goTo, { account: id })}</a>
    {/snippet}
  </LinkView>
  {/if}
</div>
