<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import { isDigestRunning } from '../lib/accounts.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { whenTitle } from '../lib/format.js'
  import { createHistoryList, durationText, type HistoryUi, runPill } from '../lib/history.js'
  import { fmt } from '../lib/i18n.js'
  import { hrefOf } from '../lib/router.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView } from '../lib/types.js'

  // Historial: every run of the account, newest first. A row opens the digest that run made.
  let {
    app,
    api,
    controller,
    texts,
    account,
    now,
  }: { app: AppState; api: Api; controller: Controller; texts: WebTexts; account: AccountView; now: number } = $props()

  const t = $derived(texts.ui.history)
  // Only the id matters: `account` is a new object on every `accounts` event and the list must not be reloaded each time.
  const list = untrack(() => createHistoryList({ api, account: account.id }))
  let ui: HistoryUi = $state.raw(list.state)
  $effect(() => {
    const id = untrack(() => account.id)
    const stop = list.subscribe((next) => (ui = next))
    // A digest that ends (the daemon says so, with no content) adds a run: the list asks for it.
    const stopEvents = controller.onHistory((changed) => {
      if (changed === id) void list.refresh()
    })
    void list.load()
    return () => {
      stop()
      stopEvents()
      list.dispose()
    }
  })

  const view = $derived(ui.view)
  const running = $derived(isDigestRunning(app.digests[account.id]))
</script>

<div class="page-inner">
  <AccountHeader {account} {texts} tab="historial" {running} />
  {#if ui.status === 'error' && view === null}
    <div class="notice bad" role="alert">
      <span>{errorText(ui.error, texts)}</span>
      <div class="acts"><button type="button" class="btn sm" onclick={() => list.load()}>{texts.ui.retry}</button></div>
    </div>
  {:else if view === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else if view.items.length === 0}
    <div class="list"><div class="empty"><p>{t.empty}</p></div></div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t.columns.number}</th>
            <th scope="col">{t.columns.date}</th>
            <th scope="col" class="hide-sm">{t.columns.origin}</th>
            <th scope="col" class="hide-sm">{t.columns.conversations}</th>
            <th scope="col" class="hide-sm">{t.columns.failed}</th>
            <th scope="col" class="hide-sm">{t.columns.duration}</th>
            <th scope="col">{t.columns.state}</th>
          </tr>
        </thead>
        <tbody>
          {#each view.items as run (run.id)}
            {@const pill = runPill(run)}
            <tr class="link">
              <td>
                <a class="rowlink" href={hrefOf({ name: 'run', id: account.id, runId: run.id })} aria-label={fmt(t.openRun, { n: run.id })}>{run.id}</a>
              </td>
              <td class="nowrap">{whenTitle(run.startedAt, account.timezone, texts.locale, now)}</td>
              <td class="hide-sm">{t.trigger[run.trigger]}</td>
              <td class="hide-sm">{run.summarized + run.failed}</td>
              <td class="hide-sm" class:bad-cell={run.failed > 0}>{run.failed}</td>
              <td class="hide-sm">{durationText(run.durationMs, texts) ?? texts.ui.text.none}</td>
              <td><span class="pill {pill.tone}">{t.outcome[pill.key]}</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="small muted" role="status">{fmt(t.shown, { shown: view.items.length, total: view.total })}</p>
    {#if view.items.length < view.total}
      <div>
        <button type="button" class="btn" disabled={ui.loadingMore} onclick={() => list.loadMore()}>
          {ui.loadingMore ? texts.ui.loading : t.loadMore}
        </button>
      </div>
    {/if}
    {#if ui.status === 'error'}
      <p class="notice bad" role="alert">{errorText(ui.error, texts)}</p>
    {/if}
  {/if}
  <p class="small muted">{t.privateNote}</p>
</div>
