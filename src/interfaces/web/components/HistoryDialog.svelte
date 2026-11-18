<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import {
    createHistoryList,
    durationText,
    failureReasonText,
    type HistoryUi,
    outcomeKey,
    outcomeTone,
    providersText,
    runErrorText,
  } from '../lib/history.js'
  import { fmt } from '../lib/i18n.js'
  import type { AccountView, HistoryRun } from '../lib/types.js'
  import Modal from './Modal.svelte'

  let {
    api,
    controller,
    texts,
    account,
    onclose,
  }: { api: Api; controller: Controller; texts: WebTexts; account: AccountView; onclose: () => void } = $props()

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

  const when = (ms: number) => formatDateTime(ms, account.timezone, texts.locale)
  const view = $derived(ui.view)
  const detail = $derived(ui.detail)
  const summary = (run: HistoryRun) => fmt(t.counts, { summarized: run.summarized, failed: run.failed })
</script>

{#snippet badge(run: HistoryRun)}
  {@const key = outcomeKey(run)}
  <span class="badge {outcomeTone(key)}">{t.outcome[key]}</span>
{/snippet}

{#snippet facts(run: HistoryRun)}
  {@const duration = durationText(run.durationMs, texts)}
  {@const reason = runErrorText(run.error, texts)}
  <div class="muted small facts">
    <span>{t.trigger[run.trigger]}</span>
    {#if duration !== null}<span>{t.durationLabel}: {duration}</span>{/if}
    <span>{summary(run)}</span>
    <span>{t.providersLabel}: {providersText(run.providers, texts)}</span>
  </div>
  {#if reason !== null}
    <p class="note error small">{reason}</p>
  {/if}
{/snippet}

<Modal title={fmt(t.title, { account: account.id })} closeLabel={texts.ui.close} {onclose}>
  {#if detail === null}
    <p class="muted small">{t.privateNote}</p>
    {#if ui.status === 'error' && view === null}
      <p class="note error" role="alert">{errorText(ui.error, texts)}</p>
      <div><button type="button" onclick={() => list.load()}>{texts.ui.retry}</button></div>
    {:else if view === null}
      <p class="muted" role="status">{texts.ui.loading}</p>
    {:else if view.items.length === 0}
      <p>{t.empty}</p>
    {:else}
      <ul class="list">
        {#each view.items as run (run.id)}
          <li>
            <div class="what">
              <strong>{when(run.startedAt)}</strong>
              {@render badge(run)}
            </div>
            {@render facts(run)}
            <div>
              <button type="button" onclick={() => list.open(run.id)}>{t.open}</button>
            </div>
          </li>
        {/each}
      </ul>
      <p class="muted small" role="status">{fmt(t.shown, { shown: view.items.length, total: view.total })}</p>
      {#if view.items.length < view.total}
        <div>
          <button type="button" disabled={ui.loadingMore} onclick={() => list.loadMore()}>
            {ui.loadingMore ? texts.ui.loading : t.loadMore}
          </button>
        </div>
      {/if}
      {#if ui.status === 'error'}
        <p class="note error" role="alert">{errorText(ui.error, texts)}</p>
      {/if}
    {/if}
  {:else}
    <div><button type="button" onclick={() => list.back()}>{t.back}</button></div>
    {#if detail.status === 'loading'}
      <p class="muted" role="status">{t.loadingDetail}</p>
    {:else if detail.status === 'error'}
      <p class="note error" role="alert">{errorText(detail.error, texts)}</p>
    {:else}
      {@const run = detail.run}
      <div class="what">
        <strong>{when(run.startedAt)}</strong>
        {@render badge(run)}
      </div>
      {@render facts(run)}
      {#if run.since !== null && run.until !== null}
        <p class="muted small">{fmt(t.window, { since: when(run.since), until: when(run.until) })}</p>
      {/if}

      <section aria-labelledby="digest-title">
        <h3 id="digest-title">{t.digestHeading}</h3>
        {#if run.digest === null}
          <p class="muted">{t.noDigest}</p>
        {:else}
          <!-- The text was written from chats of third parties: it is drawn as text, never as markup. -->
          <pre class="digest">{run.digest.text}</pre>
        {/if}
      </section>

      <section aria-labelledby="failed-title">
        <h3 id="failed-title">{t.failedHeading}</h3>
        {#if run.failedConversations.length === 0}
          <p class="muted">{t.failedNone}</p>
        {:else}
          <ul class="list">
            {#each run.failedConversations as chat (chat.id)}
              <li>
                <strong class="name">{chat.name}</strong>
                <span class="muted small">{failureReasonText(chat.reason, texts)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</Modal>

<style>
  p,
  h3 {
    margin: 0;
  }

  .small {
    font-size: 0.85rem;
  }

  section {
    display: grid;
    gap: 0.5rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  .list li {
    display: grid;
    gap: 0.4rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
  }

  .what {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
  }

  .name {
    overflow-wrap: anywhere;
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.9rem;
  }

  .badge {
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--neutral-bg);
    white-space: nowrap;
  }

  .badge.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }

  .badge.warn,
  .badge.working {
    background: var(--warn-bg);
    color: var(--warn);
  }

  .badge.error {
    background: var(--error-bg);
    color: var(--error);
  }

  .digest {
    margin: 0;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--neutral-bg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
  }
</style>
