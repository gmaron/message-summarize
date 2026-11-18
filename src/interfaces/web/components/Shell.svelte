<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { initialOf, isDigestRunning, pillOf, pillText, railStatus } from '../lib/accounts.js'
  import { fmt } from '../lib/i18n.js'
  import type { AppState } from '../lib/state.js'
  import { hrefOf, type Route } from '../lib/router.js'
  import type { AccountView } from '../lib/types.js'
  import Icon from './Icon.svelte'

  // The frame of every page: the rail of accounts (a strip on a small screen), the offline banner and the main region.
  let {
    app,
    texts,
    route,
    accounts,
    now,
    main = $bindable(),
    children,
  }: {
    app: AppState
    texts: WebTexts
    route: Route
    accounts: readonly AccountView[]
    now: number
    main?: HTMLElement | undefined
    children: Snippet
  } = $props()

  const ui = $derived(texts.ui)
  const current = $derived('id' in route ? route.id : null)

  let accountsStrip: HTMLElement | undefined = $state()
  // The strip of a small screen scrolls to the account that is open.
  $effect(() => {
    void current
    const open = accountsStrip?.querySelector<HTMLElement>('[aria-current="page"]')
    if (accountsStrip === undefined || open === null || open === undefined) return
    if (open.offsetLeft + open.offsetWidth > accountsStrip.scrollLeft + accountsStrip.clientWidth - 24) {
      accountsStrip.scrollLeft = open.offsetLeft - accountsStrip.offsetLeft
    }
  })
</script>

<div class="app">
  <nav class="rail" aria-label={ui.shell.navLabel}>
    <a class="brand" href={hrefOf({ name: 'home' })}>
      <Icon name="logo" size={22} /><span>{ui.title}</span>
    </a>
    <a class="rail-link" href={hrefOf({ name: 'home' })} aria-current={route.name === 'home' ? 'page' : undefined}>
      <Icon name="home" /><span>{ui.shell.home}</span>
    </a>
    <div class="rail-label">{ui.shell.accounts}</div>
    <div class="rail-accts" bind:this={accountsStrip}>
      {#each accounts as account (account.id)}
        {@const running = isDigestRunning(app.digests[account.id])}
        {@const pill = pillOf(account, running)}
        {@const status = railStatus(account, running, texts, now)}
        <a
          class="acct"
          href={hrefOf({ name: 'account', id: account.id, tab: 'resumen' })}
          aria-current={current === account.id ? 'page' : undefined}
        >
          <span class="av" aria-hidden="true">
            {initialOf(account.id)}<span class="dot" class:bad={pill.tone === 'bad'} class:busy={pill.tone === 'busy'} class:idle={pill.tone === 'idle'}></span>
          </span>
          <strong>{account.id}</strong>
          <span class="s" class:bad={status.bad}>{status.text}</span>
          <span class="sr">{fmt(ui.text.aside, { text: pillText(pill.key, texts) })}</span>
        </a>
      {/each}
    </div>
    <div class="rail-foot">
      <a class="rail-link" href={hrefOf({ name: 'add' })} aria-current={route.name === 'add' ? 'page' : undefined} aria-label={ui.addAccount.button}>
        <Icon name="plus" /><span>{ui.addAccount.button}</span>
      </a>
      <a class="rail-link" href={hrefOf({ name: 'logs', account: null })} aria-current={route.name === 'logs' ? 'page' : undefined} aria-label={ui.logs.open}>
        <Icon name="logs" /><span>{ui.logs.open}</span>
      </a>
    </div>
  </nav>
  <div class="main">
    {#if app.connection === 'offline'}
      <div class="offline" role="status"><Icon name="warning" />{ui.offline}</div>
    {/if}
    <main class="page" tabindex="-1" bind:this={main}>
      {@render children()}
    </main>
  </div>
</div>
