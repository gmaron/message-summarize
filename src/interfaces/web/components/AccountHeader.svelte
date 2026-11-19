<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { ACCOUNT_TABS, type AccountTab, hrefOf } from '../lib/router.js'
  import type { AccountView } from '../lib/types.js'
  import Pill from './Pill.svelte'

  // The name of the account, how it is, and its sections. The active tab scrolls into view on a small screen.
  let {
    account,
    texts,
    tab,
    running = false,
  }: { account: AccountView; texts: WebTexts; tab: AccountTab; running?: boolean } = $props()

  const labels = $derived<Record<AccountTab, string>>({
    resumen: texts.ui.tabs.summary,
    conversaciones: texts.ui.tabs.conversations,
    horarios: texts.ui.tabs.schedules,
    historial: texts.ui.tabs.history,
    ajustes: texts.ui.tabs.settings,
  })

  let strip: HTMLElement | undefined = $state()
  $effect(() => {
    tab
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]')
    if (strip !== undefined && current !== null && current !== undefined) {
      strip.scrollLeft = Math.max(0, current.offsetLeft - strip.offsetLeft - 24)
    }
  })
</script>

<div class="head">
  <h1 class="break">{account.id}</h1>
  <Pill {account} {texts} {running} />
</div>
<nav class="tabs" aria-label={texts.ui.tabs.label} bind:this={strip}>
  {#each ACCOUNT_TABS as one (one)}
    <a href={hrefOf({ name: 'account', id: account.id, tab: one })} aria-current={tab === one ? 'page' : undefined}>
      {labels[one]}
    </a>
  {/each}
</nav>
