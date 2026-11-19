<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import Icon from '../components/Icon.svelte'
  import FixAction from '../components/FixAction.svelte'
  import Pill from '../components/Pill.svelte'
  import { hasProblem, initialOf, isDigestRunning, pillOf, problemsFirst } from '../lib/accounts.js'
  import type { Controller } from '../lib/controller.js'
  import { blockedText } from '../lib/digest.js'
  import { whenTitle } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import { hrefOf } from '../lib/router.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView } from '../lib/types.js'

  // Inicio: every account on one list, the ones that need their owner first, each with the one action that fixes it.
  let {
    app,
    texts,
    controller,
    accounts,
    now,
  }: { app: AppState; texts: WebTexts; controller: Controller; accounts: readonly AccountView[]; now: number } = $props()

  const ui = $derived(texts.ui)
  const sorted = $derived(problemsFirst(accounts))
  const attention = $derived(accounts.filter(hasProblem).length)

  const reason = (account: AccountView): string | null => {
    if (!account.configValid) return ui.account.invalidConfig
    if (account.state === 'blocked' && account.blockedReason !== null) return blockedText(account.blockedReason, texts)
    return null
  }
  const when = (ms: number, account: AccountView): string => whenTitle(ms, account.timezone, texts.locale, now)
</script>

<div class="page-inner">
  {#if accounts.length === 0}
    <div class="head"><h1>{ui.accountsTitle}</h1></div>
    <div class="list">
      <div class="empty">
        <h2>{ui.noAccounts}</h2>
        <p>{ui.home.emptyText}</p>
        <a class="btn primary" href={hrefOf({ name: 'add' })}><Icon name="plus" />{ui.addAccount.button}</a>
      </div>
    </div>
  {:else}
    <div class="head">
      <div>
        <h1>{ui.accountsTitle}</h1>
        <p class="muted summary">
          {accounts.length === 1 ? ui.home.summaryOne : fmt(ui.home.summaryMany, { count: accounts.length })}{ui.text.separator}
          {#if attention === 0}
            {ui.home.allFine}
          {:else}
            <span class="bad-text strong">
              {attention === 1 ? ui.home.attentionOne : fmt(ui.home.attentionMany, { count: attention })}
            </span>
          {/if}
        </p>
      </div>
      <div class="r">
        <a class="btn" href={hrefOf({ name: 'add' })}><Icon name="plus" />{ui.addAccount.button}</a>
      </div>
    </div>
    <ul class="list">
      {#each sorted as account (account.id)}
        {@const running = isDigestRunning(app.digests[account.id])}
        {@const pill = pillOf(account, running)}
        {@const problem = reason(account)}
        <li class="row-acct">
          <span class="av" aria-hidden="true">
            {initialOf(account.id)}<span class="dot" class:bad={pill.tone === 'bad'} class:busy={pill.tone === 'busy'} class:idle={pill.tone === 'idle'}></span>
          </span>
          <div class="who">
            <span class="line">
              <a href={hrefOf({ name: 'account', id: account.id, tab: 'resumen' })}>{account.id}</a>
              <Pill {account} {texts} {running} />
            </span>
            {#if problem !== null}
              <span class="k bad-text">{problem}</span>
            {:else}
              <span class="k num">{account.maskedNumber ?? ui.account.noNumber}</span>
            {/if}
          </div>
          <div class="hide-sm">
            <span class="k">{ui.account.lastDigest}</span>
            <span class="num">{account.lastDigest === null ? ui.account.never : when(account.lastDigest, account)}</span>
          </div>
          <div class="hide-sm">
            <span class="k">{ui.home.next}</span>
            <span class="num">{account.nextRun === null ? ui.account.noSchedules : when(account.nextRun, account)}</span>
          </div>
          <div class="cluster action">
            <FixAction {account} {texts} {controller} {now} small open />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="small muted">{ui.home.privacy}</p>
</div>

<style>
  .summary {
    margin-top: 4px;
  }

  .action {
    justify-content: flex-start;
  }
</style>
