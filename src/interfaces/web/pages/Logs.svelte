<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { accountLabel, createLogsList, fieldsText, INSTALLATION, LEVELS, type LogsUi, logTime } from '../lib/logs.js'
  import { hrefOf } from '../lib/router.js'
  import type { AccountView, LogLevel } from '../lib/types.js'

  // Logs: what the service did, newest first, for one account or all. Only codes, counts and times: drawn as text.
  let {
    api,
    controller,
    texts,
    accounts,
    account,
  }: {
    api: Api
    controller: Controller
    texts: WebTexts
    accounts: readonly AccountView[]
    /** The account of the address (`?cuenta=`), or null for all. */
    account: string | null
  } = $props()

  const t = $derived(texts.ui.logs)
  const list = untrack(() => createLogsList({ api }))
  let ui: LogsUi = $state.raw(list.state)
  $effect(() => {
    const stop = list.subscribe((next) => (ui = next))
    // The daemon says that it logged (at most once a second, with no lines): the list asks for them.
    const stopEvents = controller.onLog(() => void list.refresh())
    if ((account ?? '') === '') void list.load()
    return () => {
      stop()
      stopEvents()
      list.dispose()
    }
  })
  // The account of the address decides the filter (the back button too).
  $effect(() => {
    const wanted = account ?? ''
    untrack(() => {
      if (wanted !== '' || list.state.account !== '') list.setFilters({ account: wanted })
    })
  })

  const selected = $derived(account ?? '')
  const onAccount = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value
    location.hash = hrefOf({ name: 'logs', account: value === '' ? null : value })
  }
</script>

<div class="page-inner">
  <div class="head"><h1>{t.title}</h1></div>
  <div class="cluster wide end">
    <div class="field">
      <label for="log-acct">{t.accountLabel}</label>
      <select id="log-acct" value={selected} onchange={onAccount}>
        <option value="">{t.allAccounts}</option>
        <option value={INSTALLATION}>{t.installation}</option>
        {#each accounts as one (one.id)}
          <option value={one.id}>{one.id}</option>
        {/each}
      </select>
    </div>
    <div class="chips" role="group" aria-label={t.levelLabel}>
      {#each LEVELS as level (level)}
        <button type="button" class="chip" aria-pressed={ui.level === level} onclick={() => list.setFilters({ level: level as LogLevel })}>
          {t.levels[level]}
        </button>
      {/each}
    </div>
  </div>

  {#if ui.status === 'error' && ui.items.length === 0}
    <div class="notice bad" role="alert">
      <span>{errorText(ui.error, texts)}</span>
      <div class="acts"><button type="button" class="btn sm" onclick={() => list.load()}>{texts.ui.retry}</button></div>
    </div>
  {:else if ui.status === 'loading'}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <!-- Every value is drawn as text (never as markup), whatever it holds. -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t.timeColumn}</th>
            <th scope="col">{t.levelColumn}</th>
            <th scope="col">{t.accountColumn}</th>
            <th scope="col">{t.messageColumn}</th>
          </tr>
        </thead>
        <tbody>
          {#if ui.items.length === 0}
            <tr><td colspan="4" class="empty-cell">{t.empty}</td></tr>
          {:else}
            {#each ui.items as entry (entry.seq)}
              <tr>
                <td class="num nowrap">{logTime(entry.time, texts.locale)}</td>
                <td><span class="lvl {entry.level}">{t.badge[entry.level]}</span></td>
                <td>{accountLabel(entry.account, texts)}</td>
                <td class="log">{entry.event}{Object.keys(entry.fields).length > 0 ? ` ${fieldsText(entry.fields)}` : ''}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    {#if ui.more}
      <div>
        <button type="button" class="btn" disabled={ui.loadingOlder} onclick={() => list.loadOlder()}>
          {ui.loadingOlder ? texts.ui.loading : t.loadOlder}
        </button>
      </div>
    {/if}
    {#if ui.error !== null}
      <p class="notice bad" role="alert">{errorText(ui.error, texts)}</p>
    {/if}
  {/if}
  <p class="small muted">{t.note}</p>
  <p class="small muted" role="status">{t.live}</p>
</div>
