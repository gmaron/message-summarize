<script lang="ts">
  import { untrack } from 'svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import Icon from './components/Icon.svelte'
  import Shell from './components/Shell.svelte'
  import LanguageSwitch from './components/LanguageSwitch.svelte'
  import Wizard from './components/Wizard.svelte'
  import type { Api } from './lib/api.js'
  import { startClock } from './lib/clock.js'
  import type { Controller } from './lib/controller.js'
  import { errorText } from './lib/digest.js'
  import { textsFor } from './lib/i18n.js'
  import { accountOfRoute, hrefOf, parseRoute, type Route, watchHash } from './lib/router.js'
  import type { AppState } from './lib/state.js'
  import AddAccount from './pages/AddAccount.svelte'
  import Conversations from './pages/Conversations.svelte'
  import History from './pages/History.svelte'
  import Home from './pages/Home.svelte'
  import Link from './pages/Link.svelte'
  import Logs from './pages/Logs.svelte'
  import Overview from './pages/Overview.svelte'
  import Ask from './pages/Ask.svelte'
  import Preview from './pages/Preview.svelte'
  import Prompt from './pages/Prompt.svelte'
  import RunDetail from './pages/RunDetail.svelte'
  import Schedules from './pages/Schedules.svelte'
  import Settings from './pages/Settings.svelte'

  let { controller, api }: { controller: Controller; api: Api } = $props()

  // `app` and not `state`: a variable called `state` would make `$state` a store.
  let app: AppState = $state.raw(untrack(() => controller.state))
  $effect(() => controller.subscribe((next) => (app = next)))

  // The token pasted on the "no access" screen: it lives only in this field, goes in one request and the field is emptied.
  let pasted = $state('')
  let signingIn = $state(false)
  let signInProblem: 'wrong' | 'failed' | null = $state(null)
  async function signIn(event: SubmitEvent) {
    event.preventDefault()
    if (signingIn || pasted.trim() === '') return
    const sending = pasted
    pasted = ''
    signingIn = true
    signInProblem = null
    const result = await controller.signIn(sending)
    signingIn = false
    if (result === 'invalid' || result === 'rejected') signInProblem = 'wrong'
    else if (result === 'failed') signInProblem = 'failed'
  }

  const texts = $derived(textsFor(app.language))
  const ui = $derived(texts.ui)

  // Where the page is: the address says it, the back button works, an address nobody knows is the home page.
  let route: Route = $state.raw(parseRoute(location.hash))
  // Pages with text typed and not saved say so: leaving them asks first. The address goes back to where it was and
  // the question is asked; "discard" goes where the person was going.
  let unsaved = false
  let currentHash = location.hash
  let leaving: string | null = $state(null)
  $effect(() =>
    watchHash(window, (next) => {
      const hash = location.hash
      if (hash === currentHash) {
        route = next
        return
      }
      if (unsaved) {
        leaving = hash
        history.replaceState(null, '', currentHash === '' ? '#/' : currentHash)
        return
      }
      currentHash = hash
      route = next
    }),
  )
  const setUnsaved = (value: boolean): void => {
    unsaved = value
  }
  function discardAndLeave() {
    const target = leaving
    leaving = null
    unsaved = false
    if (target !== null) location.hash = target
  }

  // One clock for every page: relative days ("today", "tomorrow") and "next at" texts come from the same moment.
  let now = $state(Date.now())
  $effect(() => startClock((tick) => (now = tick)))

  // The logs page stays mounted when its account changes (the select keeps the focus); every other address is a page.
  const pageKey = $derived(route.name === 'logs' ? '#/logs' : hrefOf(route))
  const routeAccount = $derived(accountOfRoute(route))
  const accounts = $derived(app.accounts ?? [])
  const account = $derived(routeAccount === null ? null : (accounts.find((row) => row.id === routeAccount) ?? null))

  $effect(() => {
    document.documentElement.lang = app.language
    document.title = account === null ? ui.title : `${account.id} · ${ui.title}`
  })

  // An account that does not exist (a stale address) is the home page.
  $effect(() => {
    if (routeAccount !== null && app.accounts !== null && account === null) location.replace(hrefOf({ name: 'home' }))
  })

  // Going to another page puts the focus on its content and the view at its top.
  let main: HTMLElement | undefined = $state()
  let shown: string | null = null
  $effect(() => {
    const key = pageKey
    if (shown !== null && shown !== key) {
      untrack(() => {
        main?.focus({ preventScroll: true })
        window.scrollTo(0, 0)
      })
    }
    shown = key
  })
</script>

{#if app.unauthorized}
  <main class="center-card" tabindex="-1">
    <h1>{ui.unauthorizedTitle}</h1>
    <p>{ui.unauthorizedText}</p>
    <form class="stack-sm" onsubmit={signIn}>
      <div class="field">
        <label for="access-key">{ui.signInLabel}</label>
        <input
          id="access-key"
          type="password"
          bind:value={pasted}
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          autocapitalize="off"
          spellcheck="false"
          disabled={signingIn}
        />
      </div>
      <div aria-live="polite">
        {#if signInProblem !== null}
          <p class="notice bad small" role="alert">{signInProblem === 'wrong' ? ui.signInWrong : ui.signInFailed}</p>
        {/if}
      </div>
      <div><button type="submit" class="btn primary" disabled={signingIn || pasted.trim() === ''}>{signingIn ? ui.signInBusy : ui.signInButton}</button></div>
    </form>
    <p class="small muted">{ui.unauthorizedOwner}</p>
    <p><code class="cmd">msum open</code></p>
    <p class="small muted">{ui.unauthorizedNote}</p>
    <LanguageSwitch {texts} current={app.language} onchoose={(language) => controller.setLanguage(language)} />
  </main>
{:else if app.accounts === null || app.setup === null}
  {#if app.loadError !== null}
    <main class="center-card" tabindex="-1">
      <p class="notice bad" role="alert">{ui.loadFailed} {errorText(app.loadError, texts)}</p>
      <div><button type="button" class="btn" onclick={() => controller.refreshAccounts()}>{ui.retry}</button></div>
    </main>
  {:else}
    <main class="page-bare" tabindex="-1"><p class="muted" role="status">{ui.loading}</p></main>
  {/if}
{:else if !app.setup.completed}
  {#if app.connection === 'offline'}
    <div class="offline" role="status"><Icon name="warning" />{ui.offline}</div>
  {/if}
  <main class="page-bare" tabindex="-1" bind:this={main}>
    <Wizard {controller} {api} {texts} {app} setup={app.setup} />
  </main>
{:else}
  <Shell {app} {texts} {route} {accounts} {now} bind:main>
    {#key pageKey}
      {#if route.name === 'home' || (routeAccount !== null && account === null)}
        <Home {app} {texts} {controller} {accounts} {now} />
      {:else if route.name === 'add'}
        <AddAccount {app} {api} {texts} {controller} />
      {:else if route.name === 'logs'}
        <Logs {api} {controller} {texts} {accounts} account={route.account} />
      {:else if account !== null}
        {#if route.name === 'account' && route.tab === 'resumen'}
          <Overview {app} {api} {texts} {controller} {account} {accounts} {now} />
        {:else if route.name === 'account' && route.tab === 'pedir'}
          <Ask {app} {api} {texts} {account} {now} />
        {:else if route.name === 'account' && route.tab === 'conversaciones'}
          <Conversations {app} {api} {texts} {account} {now} />
        {:else if route.name === 'account' && route.tab === 'horarios'}
          <Schedules {app} {api} {texts} {account} {now} />
        {:else if route.name === 'account' && route.tab === 'historial'}
          <History {app} {api} {controller} {texts} {account} {now} />
        {:else if route.name === 'account'}
          <Settings {app} {api} {texts} {account} ondirty={setUnsaved} />
        {:else if route.name === 'run'}
          <RunDetail {api} {controller} {texts} {account} runId={route.runId} {now} />
        {:else if route.name === 'prompt'}
          <Prompt {api} {texts} {account} ondirty={setUnsaved} />
        {:else if route.name === 'preview'}
          <Preview {app} {texts} {controller} {account} {now} />
        {:else if route.name === 'link'}
          <Link {app} {api} {texts} {controller} {account} />
        {/if}
      {/if}
    {/key}
  </Shell>
{/if}

{#if leaving !== null}
  <ConfirmDialog
    title={ui.guard.title}
    confirmLabel={ui.guard.discard}
    cancelLabel={ui.guard.keep}
    tone="danger"
    onconfirm={discardAndLeave}
    oncancel={() => (leaving = null)}
  >
    <p>{ui.guard.text}</p>
  </ConfirmDialog>
{/if}
