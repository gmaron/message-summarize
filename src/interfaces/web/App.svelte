<script lang="ts">
  import { untrack } from 'svelte'
  import AccountCard from './components/AccountCard.svelte'
  import AddAccount from './components/AddAccount.svelte'
  import ConversationsDialog from './components/ConversationsDialog.svelte'
  import HistoryDialog from './components/HistoryDialog.svelte'
  import LogsDialog from './components/LogsDialog.svelte'
  import LinkDialog from './components/LinkDialog.svelte'
  import PreviewDialog from './components/PreviewDialog.svelte'
  import PromptDialog from './components/PromptDialog.svelte'
  import SchedulesDialog from './components/SchedulesDialog.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import type { Api } from './lib/api.js'
  import type { Controller } from './lib/controller.js'
  import { errorText } from './lib/digest.js'
  import { textsFor } from './lib/i18n.js'
  import type { AppState } from './lib/state.js'

  let { controller, api }: { controller: Controller; api: Api } = $props()

  // `app` and not `state`: a variable called `state` would make `$state` a store.
  let app: AppState = $state.raw(untrack(() => controller.state))
  $effect(() => controller.subscribe((next) => (app = next)))

  const texts = $derived(textsFor(app.language))
  const ui = $derived(texts.ui)
  $effect(() => {
    document.documentElement.lang = app.language
    document.title = ui.title
  })

  type Dialog = { kind: 'link' | 'schedules' | 'conversations' | 'history' | 'settings' | 'prompt' | 'preview'; id: string }
  let dialog: Dialog | null = $state.raw(null)
  const accountOf = (id: string) => app.accounts?.find((account) => account.id === id) ?? null

  function openLink(id: string) {
    dialog = { kind: 'link', id }
    if (accountOf(id)?.state === 'linking') controller.restoreLink(id)
    else controller.startLink(id)
  }
  function openPreview(id: string) {
    dialog = { kind: 'preview', id }
    controller.startPreview(id)
  }
  let retryErrors: Record<string, string | null> = $state.raw({})
  async function retry(id: string) {
    const code = await controller.retry(id)
    retryErrors = { ...retryErrors, [id]: code }
  }
  const close = () => (dialog = null)
  let showLogs = $state(false)
</script>

<header class="top">
  <h1>{ui.title}</h1>
  {#if !app.unauthorized && app.accounts !== null}
    <button type="button" class="logs-button" onclick={() => (showLogs = true)}>{ui.logs.open}</button>
  {/if}
  {#if app.connection === 'offline'}
    <p class="note warn" role="status">{ui.offline}</p>
  {/if}
</header>

<main>
  {#if app.unauthorized}
    <section class="center" aria-labelledby="unauthorized-title">
      <h2 id="unauthorized-title">{ui.unauthorizedTitle}</h2>
      <p class="note error">{texts.errors.unauthorized}</p>
    </section>
  {:else if app.accounts === null}
    {#if app.loadError !== null}
      <section class="center">
        <p class="note error" role="alert">{ui.loadFailed} {errorText(app.loadError, texts)}</p>
        <button type="button" onclick={() => controller.refreshAccounts()}>{ui.retry}</button>
      </section>
    {:else}
      <p class="muted center" role="status">{ui.loading}</p>
    {/if}
  {:else}
    <section aria-labelledby="accounts-title">
      <div class="row">
        <h2 id="accounts-title">{ui.accountsTitle}</h2>
        <AddAccount {controller} {texts} onadded={openLink} />
      </div>
      {#if app.accounts.length === 0}
        <p class="muted">{ui.noAccounts}</p>
      {:else}
        <ul class="cards">
          {#each app.accounts as account (account.id)}
            <li>
              <AccountCard
                {account}
                {texts}
                digest={app.digests[account.id]}
                retryError={retryErrors[account.id] ?? null}
                ondigest={() => controller.digestNow(account.id)}
                onpreview={() => openPreview(account.id)}
                onschedules={() => (dialog = { kind: 'schedules', id: account.id })}
                onconversations={() => (dialog = { kind: 'conversations', id: account.id })}
                onhistory={() => (dialog = { kind: 'history', id: account.id })}
                onsettings={() => (dialog = { kind: 'settings', id: account.id })}
                onprompt={() => (dialog = { kind: 'prompt', id: account.id })}
                onlink={() => openLink(account.id)}
                onretry={() => retry(account.id)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

{#if showLogs && app.accounts !== null}
  <LogsDialog {api} {controller} {texts} accounts={app.accounts} onclose={() => (showLogs = false)} />
{/if}

{#if dialog !== null && app.accounts !== null}
  {@const account = accountOf(dialog.id)}
  {#if account !== null}
    {#if dialog.kind === 'link'}
      <LinkDialog {controller} {api} {texts} id={account.id} link={app.links[account.id]} onclose={close} />
    {:else if dialog.kind === 'schedules'}
      <SchedulesDialog {api} {texts} {account} onclose={close} />
    {:else if dialog.kind === 'conversations'}
      <ConversationsDialog {api} {texts} {account} onclose={close} />
    {:else if dialog.kind === 'history'}
      <HistoryDialog {api} {controller} {texts} {account} onclose={close} />
    {:else if dialog.kind === 'settings'}
      <SettingsDialog {api} {texts} {account} onclose={close} />
    {:else if dialog.kind === 'prompt'}
      <PromptDialog {api} {texts} {account} onclose={close} onpreview={() => openPreview(account.id)} />
    {:else}
      <PreviewDialog {controller} {texts} {account} preview={app.previews[account.id]} onclose={close} />
    {/if}
  {/if}
{/if}

<style>
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1.5rem;
    padding: 1rem;
    max-width: 72rem;
    margin: 0 auto;
  }

  .logs-button {
    margin-left: auto;
  }

  main {
    max-width: 72rem;
    margin: 0 auto;
    padding: 0 1rem 2rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .center {
    max-width: 34rem;
    margin: 2rem auto;
    display: grid;
    gap: 0.75rem;
  }

  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
  }
</style>
