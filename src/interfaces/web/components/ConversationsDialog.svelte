<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import { type ConversationsUi, createConversationList, type MarkKey, toggleState, unreadText } from '../lib/conversations.js'
  import { errorText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import type { AccountView, MarkState } from '../lib/types.js'
  import Modal from './Modal.svelte'

  let {
    api,
    texts,
    account,
    onclose,
  }: { api: Api; texts: WebTexts; account: AccountView; onclose: () => void } = $props()

  const t = $derived(texts.ui.conversations)
  // Only the id matters: `account` is a new object on every `accounts` event and the list must not be reloaded each time.
  const list = untrack(() => createConversationList({ api, account: account.id }))
  let ui: ConversationsUi = $state.raw(list.state)
  $effect(() => {
    const stop = list.subscribe((next) => (ui = next))
    void list.load()
    return () => {
      stop()
      list.dispose()
    }
  })

  const view = $derived(ui.view)
  const localAvailable = $derived(view?.localAvailable ?? false)
  const keys: readonly MarkKey[] = ['excluded', 'localOnly']
  const label = (key: MarkKey): string => (key === 'excluded' ? t.exclude : t.localOnly)
</script>

{#snippet toggles(id: string, item: MarkState)}
  <div class="toggles">
    {#each keys as key (key)}
      {@const state = toggleState(item, key, localAvailable)}
      <label class="toggle" class:on={state.checked}>
        <input
          type="checkbox"
          checked={state.checked}
          disabled={state.disabled || ui.saving.includes(id)}
          onchange={(event) => list.toggle(id, key, event.currentTarget.checked)}
        />
        <span>{label(key)}</span>
      </label>
    {/each}
  </div>
  {#if item.marks.excluded === 'pattern' || item.marks.localOnly === 'pattern'}
    <p class="muted small">{t.fromPattern}</p>
  {/if}
  {#if ui.rowErrors[id] !== undefined}
    <p class="note error small" role="alert">{errorText(ui.rowErrors[id], texts)}</p>
  {/if}
  {#if ui.confirming?.id === id}
    <div class="note warn" role="alertdialog" aria-label={t.exclude}>
      <p>{fmt(t.confirmDelete, { count: ui.confirming.messages })}</p>
      <div class="row-buttons">
        <button type="button" class="danger" onclick={() => list.confirm()}>{t.confirmYes}</button>
        <button type="button" onclick={() => list.cancelConfirm()}>{texts.ui.cancel}</button>
      </div>
    </div>
  {/if}
{/snippet}

<Modal title={fmt(t.title, { account: account.id })} closeLabel={texts.ui.close} {onclose}>
  <div class="explain muted small">
    <p>{t.explainExclude}</p>
    <p>{t.explainLocalOnly}</p>
    <p>{t.aliasNote}</p>
  </div>
  {#if view !== null && !localAvailable}
    <p class="note warn small">{t.localUnavailable}</p>
  {/if}

  <label class="search">
    <span>{t.searchLabel}</span>
    <input
      type="search"
      value={ui.query}
      placeholder={t.searchPlaceholder}
      autocomplete="off"
      oninput={(event) => list.setQuery(event.currentTarget.value)}
    />
  </label>

  {#if ui.status === 'error' && view === null}
    <p class="note error" role="alert">{errorText(ui.error, texts)}</p>
    <div><button type="button" onclick={() => list.load()}>{texts.ui.retry}</button></div>
  {:else if view === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    {#if view.unlisted.length > 0}
      <section aria-labelledby="unlisted-title">
        <h3 id="unlisted-title">{t.unlistedHeading}</h3>
        <p class="muted small">{t.unlistedHint}</p>
        <ul class="list">
          {#each view.unlisted as item (item.id)}
            <li>
              <div class="what"><strong class="name">{item.id}</strong></div>
              {@render toggles(item.id, item)}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if view.items.length === 0}
      <p>{ui.query.trim() === '' ? t.empty : t.noResults}</p>
    {:else}
      <ul class="list">
        {#each view.items as item (item.id)}
          {@const unread = unreadText(item.unread, texts)}
          <li>
            <div class="what">
              <strong class="name">{item.name}</strong>
              <span class="tag">{item.isGroup ? t.group : t.individual}</span>
              {#if unread !== null}<span class="tag unread">{unread}</span>{/if}
            </div>
            <div class="muted small">
              <span>{item.address}</span>
              ·
              <span>
                {item.lastMessageAt === null
                  ? t.noMessages
                  : fmt(t.lastMessage, { when: formatDateTime(item.lastMessageAt, view.timezone, texts.locale) })}
              </span>
              ·
              <span>{fmt(t.messages, { count: item.messages })}</span>
            </div>
            {@render toggles(item.id, item)}
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
    {/if}
    {#if ui.status === 'error'}
      <p class="note error" role="alert">{errorText(ui.error, texts)}</p>
    {/if}
  {/if}
</Modal>

<style>
  p,
  h3 {
    margin: 0;
  }

  .explain {
    display: grid;
    gap: 0.25rem;
  }

  .small {
    font-size: 0.85rem;
  }

  .search {
    display: grid;
    gap: 0.25rem;
    font-weight: 600;
  }

  .search input {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
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

  .tag {
    font-size: 0.75rem;
    padding: 0.05rem 0.5rem;
    border-radius: 999px;
    background: var(--neutral-bg);
  }

  .tag.unread {
    background: var(--warn-bg);
    color: var(--warn);
  }

  .toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
  }

  .toggle.on {
    border-color: var(--accent);
    background: var(--neutral-bg);
  }

  .row-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
