<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import ConfigNotice from '../components/ConfigNotice.svelte'
  import ConfirmDialog from '../components/ConfirmDialog.svelte'
  import Icon from '../components/Icon.svelte'
  import Switch from '../components/Switch.svelte'
  import { accountActions, isDigestRunning } from '../lib/accounts.js'
  import type { Api } from '../lib/api.js'
  import { type ConversationsUi, createConversationList, toggleState, unreadText } from '../lib/conversations.js'
  import { errorText } from '../lib/digest.js'
  import { whenText } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, ConversationItem, UnlistedItem } from '../lib/types.js'

  // Conversaciones: which chats are summarized and which never leave this machine, as two switches per row.
  let {
    app,
    api,
    texts,
    account,
    now,
  }: { app: AppState; api: Api; texts: WebTexts; account: AccountView; now: number } = $props()
  const usable = $derived(accountActions(account).conversations)

  const t = $derived(texts.ui.conversations)
  // Only the id matters: `account` is a new object on every `accounts` event and the list must not be reloaded each time.
  const list = untrack(() => createConversationList({ api, account: account.id }))
  let ui: ConversationsUi = $state.raw(list.state)
  $effect(() => {
    const stop = list.subscribe((next) => (ui = next))
    if (untrack(() => usable)) void list.load()
    return () => {
      stop()
      list.dispose()
    }
  })

  type Filter = 'all' | 'excluded' | 'local'
  let filter: Filter = $state('all')
  const filters: readonly Filter[] = ['all', 'excluded', 'local']

  const view = $derived(ui.view)
  const localAvailable = $derived(view?.localAvailable ?? false)
  const keep = (item: { excluded: boolean; localOnly: boolean }): boolean =>
    filter === 'all' || (filter === 'excluded' && item.excluded) || (filter === 'local' && item.localOnly)
  const items = $derived((view?.items ?? []).filter(keep))
  const unlisted = $derived((view?.unlisted ?? []).filter(keep))
  const running = $derived(isDigestRunning(app.digests[account.id]))

  const sub = (item: ConversationItem): string => {
    const parts = [
      item.isGroup ? t.group : t.individual,
      item.address,
      item.lastMessageAt === null
        ? t.noMessages
        : fmt(t.lastMessage, { when: whenText(item.lastMessageAt, view?.timezone ?? account.timezone, texts.locale, now) }),
    ]
    parts.push(fmt(t.messages, { count: item.messages }))
    const unread = unreadText(item.unread, texts)
    return (unread === null ? parts : [...parts, unread]).join(texts.ui.text.separator)
  }
  const fixedByPattern = (item: ConversationItem | UnlistedItem): boolean =>
    item.marks.excluded === 'pattern' || item.marks.localOnly === 'pattern'
  const confirming = $derived(ui.confirming)
  const nameOf = (item: ConversationItem | UnlistedItem): string => ('name' in item ? item.name : item.id)

  // With a filter on, what is left to show may be on pages not loaded yet: they are loaded, one after the other.
  $effect(() => {
    if (filter === 'all' || view === null || ui.loadingMore || ui.status === 'error') return
    if (view.items.length < view.total) untrack(() => void list.loadMore())
  })
</script>

{#snippet marks(item: ConversationItem | UnlistedItem)}
  {@const ex = toggleState(item, 'excluded', localAvailable)}
  {@const lo = toggleState(item, 'localOnly', localAvailable)}
  {@const saving = ui.saving.includes(item.id)}
  <label class="sw">
    <Switch
      label={fmt(texts.ui.text.labelled, { label: t.summarize, value: nameOf(item) })}
      checked={!item.excluded}
      disabled={ex.disabled || saving}
      onchange={(on) => list.toggle(item.id, 'excluded', !on)}
    />
    {t.summarize}
  </label>
  <label class="sw" class:off={item.excluded}>
    <Switch
      label={fmt(texts.ui.text.labelled, { label: t.localOnly, value: nameOf(item) })}
      checked={item.localOnly}
      disabled={item.excluded || lo.disabled || saving}
      describedby={item.excluded ? `ex-${item.id}` : undefined}
      onchange={(on) => list.toggle(item.id, 'localOnly', on)}
    />
    {t.localOnly}
  </label>
  {#if item.excluded}
    <span class="sub wide" id="ex-{item.id}">{t.excludedNote}</span>
  {/if}
  {#if fixedByPattern(item)}
    <span class="sub wide">{t.fromPattern}</span>
  {/if}
  {#if saving}
    <span class="sub wide" role="status">{t.saving}</span>
  {/if}
  {#if ui.rowErrors[item.id] !== undefined}
    <span class="sub wide bad-text" role="alert">{errorText(ui.rowErrors[item.id], texts)}</span>
  {/if}
{/snippet}

<div class="page-inner">
  <AccountHeader {account} {texts} tab="conversaciones" {running} />
  {#if !usable}
    <ConfigNotice {texts} {account} />
  {:else}

  <div class="notice info">
    <div class="row">
      <Icon name="lock" />
      <div class="stack-sm">
        <span><b>{t.exclude}</b> {t.explainExclude} <b>{t.localOnly}</b> {t.explainLocalOnly}</span>
        <span class="small">{t.aliasNote}</span>
      </div>
    </div>
  </div>
  {#if view !== null && !localAvailable}
    <p class="notice warn small">{t.localUnavailable}</p>
  {/if}

  <div class="cluster wide">
    <label class="sr" for="conv-q">{t.searchLabel}</label>
    <div class="search-box">
      <Icon name="search" />
      <input
        type="search"
        id="conv-q"
        placeholder={t.searchPlaceholder}
        value={ui.query}
        autocomplete="off"
        oninput={(event) => list.setQuery(event.currentTarget.value)}
      />
    </div>
    <div class="chips" role="group" aria-label={t.filterLabel}>
      {#each filters as one (one)}
        <button type="button" class="chip" aria-pressed={filter === one} onclick={() => (filter = one)}>{t.filters[one]}</button>
      {/each}
    </div>
    {#if view !== null}
      <span class="small muted num count" role="status">{filter === 'all'
          ? fmt(t.shown, { shown: items.length + unlisted.length, total: view.total + view.unlisted.length })
          : fmt(t.shownOfLoaded, { shown: items.length + unlisted.length, loaded: view.items.length + view.unlisted.length })}</span>
    {/if}
  </div>

  {#if ui.status === 'error' && view === null}
    <div class="notice bad" role="alert">
      <span>{errorText(ui.error, texts)}</span>
      <div class="acts"><button type="button" class="btn sm" onclick={() => list.load()}>{texts.ui.retry}</button></div>
    </div>
  {:else if view === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    {#if unlisted.length > 0}
      <section class="stack-sm" aria-labelledby="unlisted-title">
        <h3 id="unlisted-title">{t.unlistedHeading}</h3>
        <p class="small muted">{t.unlistedHint}</p>
        <ul class="list">
          {#each unlisted as item (item.id)}
            <li class="conv" class:excluded={item.excluded}>
              <div><div class="name">{item.id}</div></div>
              {@render marks(item)}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if items.length === 0 && unlisted.length === 0}
      <div class="list">
        <div class="empty">
          <h2>{filter === 'all' && ui.query.trim() === '' ? t.empty : t.noResults}</h2>
          {#if filter !== 'all' || ui.query.trim() !== ''}
            <p>{t.noResultsHint}</p>
            <button
              type="button"
              class="btn"
              onclick={() => {
                filter = 'all'
                list.setQuery('')
              }}
            >
              {t.showAll}
            </button>
          {/if}
        </div>
      </div>
    {:else if items.length > 0}
      <ul class="list">
        {#each items as item (item.id)}
          <li class="conv" class:excluded={item.excluded}>
            <div>
              <div class="name">{item.name}</div>
              <div class="sub">{sub(item)}</div>
            </div>
            {@render marks(item)}
          </li>
        {/each}
      </ul>
    {/if}
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
  {/if}
</div>

{#if confirming !== null}
  <ConfirmDialog
    title={t.exclude}
    confirmLabel={t.confirmYes}
    cancelLabel={texts.ui.cancel}
    tone="danger"
    onconfirm={() => list.confirm()}
    oncancel={() => list.cancelConfirm()}
  >
    <p>{fmt(t.confirmDelete, { count: confirming.messages })}</p>
  </ConfirmDialog>
{/if}

<style>
  .count {
    margin-left: auto;
  }
</style>
