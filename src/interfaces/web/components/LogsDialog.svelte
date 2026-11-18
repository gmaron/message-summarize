<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import {
    accountLabel,
    createLogsList,
    fieldsText,
    INSTALLATION,
    LEVELS,
    levelTone,
    type LogsUi,
    logTime,
  } from '../lib/logs.js'
  import type { AccountView, LogLevel } from '../lib/types.js'
  import Modal from './Modal.svelte'

  let {
    api,
    controller,
    texts,
    accounts,
    onclose,
  }: { api: Api; controller: Controller; texts: WebTexts; accounts: readonly AccountView[]; onclose: () => void } =
    $props()

  const t = $derived(texts.ui.logs)
  const list = untrack(() => createLogsList({ api }))
  let ui: LogsUi = $state.raw(list.state)
  $effect(() => {
    const stop = list.subscribe((next) => (ui = next))
    // The daemon says that it logged (at most once a second, with no lines): the list asks for them.
    const stopEvents = controller.onLog(() => void list.refresh())
    void list.load()
    return () => {
      stop()
      stopEvents()
      list.dispose()
    }
  })

  const onLevel = (event: Event) => list.setFilters({ level: (event.currentTarget as HTMLSelectElement).value as LogLevel })
  const onAccount = (event: Event) => list.setFilters({ account: (event.currentTarget as HTMLSelectElement).value })
</script>

<Modal title={t.title} closeLabel={texts.ui.close} {onclose}>
  <p class="muted small">{t.note}</p>
  <div class="filters">
    <label>
      <span>{t.levelLabel}</span>
      <select value={ui.level} onchange={onLevel}>
        {#each LEVELS as level (level)}
          <option value={level}>{t.level[level]}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>{t.accountLabel}</span>
      <select value={ui.account} onchange={onAccount}>
        <option value="">{t.allAccounts}</option>
        <option value={INSTALLATION}>{t.installation}</option>
        {#each accounts as account (account.id)}
          <option value={account.id}>{account.id}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if ui.status === 'error' && ui.items.length === 0}
    <p class="note error" role="alert">{errorText(ui.error, texts)}</p>
    <div><button type="button" onclick={() => list.load()}>{texts.ui.retry}</button></div>
  {:else if ui.status === 'loading'}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else if ui.items.length === 0}
    <p>{t.empty}</p>
  {:else}
    <!-- Every value is drawn as text (never as markup), whatever it holds. -->
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{t.timeColumn}</th>
            <th scope="col">{t.levelColumn}</th>
            <th scope="col">{t.eventColumn}</th>
            <th scope="col">{t.accountColumn}</th>
            <th scope="col">{t.detailsColumn}</th>
          </tr>
        </thead>
        <tbody>
          {#each ui.items as entry (entry.seq)}
            <tr>
              <td class="time">{logTime(entry.time, texts.locale)}</td>
              <td><span class="badge {levelTone(entry.level)}">{entry.level}</span></td>
              <td class="code">{entry.event}</td>
              <td>{accountLabel(entry.account, texts)}</td>
              <td class="code details">{fieldsText(entry.fields)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if ui.more}
      <div>
        <button type="button" disabled={ui.loadingOlder} onclick={() => list.loadOlder()}>
          {ui.loadingOlder ? texts.ui.loading : t.loadOlder}
        </button>
      </div>
    {/if}
    {#if ui.error !== null}
      <p class="note error" role="alert">{errorText(ui.error, texts)}</p>
    {/if}
  {/if}
  <p class="muted small" role="status">{t.live}</p>
</Modal>

<style>
  p {
    margin: 0;
  }

  .small {
    font-size: 0.85rem;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
  }

  .filters label {
    display: grid;
    gap: 0.2rem;
    font-size: 0.85rem;
  }

  .scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .time {
    white-space: nowrap;
  }

  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }

  .details {
    min-width: 10rem;
  }

  .badge {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    background: var(--neutral-bg);
  }

  .badge.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }

  .badge.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }

  .badge.error {
    background: var(--error-bg);
    color: var(--error);
  }
</style>
