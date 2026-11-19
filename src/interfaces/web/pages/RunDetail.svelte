<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import DigestThread from '../components/DigestThread.svelte'
  import Icon from '../components/Icon.svelte'
  import type { Api } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { dayChip, formatDateTime, formatTime, whenTitle } from '../lib/format.js'
  import { createHistoryList, durationText, failureReasonText, type HistoryUi, providersText, runErrorText, runPill } from '../lib/history.js'
  import { fmt } from '../lib/i18n.js'
  import { hrefOf } from '../lib/router.js'
  import type { AccountView } from '../lib/types.js'

  // One run: what it said (the digest, as a bubble), how it went and which chats could not be summarized.
  let {
    api,
    controller,
    texts,
    account,
    runId,
    now,
  }: { api: Api; controller: Controller; texts: WebTexts; account: AccountView; runId: number; now: number } = $props()

  const t = $derived(texts.ui.history)
  const id = $derived(account.id)
  const list = untrack(() => createHistoryList({ api, account: account.id }))
  let ui: HistoryUi = $state.raw(list.state)
  $effect(() => {
    const stop = list.subscribe((next) => (ui = next))
    // A run that is still open changes when it ends: the daemon says so and it is asked for again.
    const stopEvents = controller.onHistory((changed) => {
      if (changed === untrack(() => id) && ui.detail?.run?.outcome === null) void list.open(untrack(() => runId))
    })
    return () => {
      stop()
      stopEvents()
      list.dispose()
    }
  })
  $effect(() => {
    const run = runId
    untrack(() => void list.open(run))
  })

  const detail = $derived(ui.detail)
  const failedTitle = (count: number): string => (count === 1 ? t.failedTitleOne : fmt(t.failedTitleMany, { count }))
</script>

<div class="page-inner">
  <div class="crumb">
    <a href={hrefOf({ name: 'account', id, tab: 'historial' })}><Icon name="back" />{fmt(t.back, { account: id })}</a>
  </div>

  {#if detail === null || detail.status === 'loading'}
    <div class="head"><h1>{fmt(t.runTitle, { n: runId })}</h1></div>
    <p class="muted" role="status">{t.loadingDetail}</p>
  {:else if detail.status === 'error'}
    <div class="head"><h1>{fmt(t.runTitle, { n: runId })}</h1></div>
    <div class="notice bad" role="alert">{errorText(detail.error, texts)}</div>
  {:else}
    {@const run = detail.run}
    {@const pill = runPill(run)}
    {@const duration = durationText(run.durationMs, texts)}
    {@const reason = runErrorText(run.error, texts)}
    {@const total = run.summarized + run.failed}
    <div class="head">
      <h1>{fmt(t.runTitle, { n: run.id })}</h1>
      <span class="pill {pill.tone}">{t.outcome[pill.key]}</span>
      <div class="r">
        <a class="btn" href={hrefOf({ name: 'logs', account: id })}><Icon name="logs" />{fmt(t.viewLogs, { account: id })}</a>
      </div>
    </div>
    <p class="meta-line num">
      <span>{whenTitle(run.startedAt, account.timezone, texts.locale, now)}</span>
      <span>{t.trigger[run.trigger]}</span>
      <span>{total === 1 ? t.conversationsOne : fmt(t.conversationsCount, { count: total })}</span>
      <span>{providersText(run.providers, texts)}</span>
      {#if duration !== null}<span>{fmt(t.took, { duration })}</span>{/if}
      {#if run.since !== null && run.until !== null}
        <span>{fmt(t.window, { since: formatDateTime(run.since, account.timezone, texts.locale), until: formatDateTime(run.until, account.timezone, texts.locale) })}</span>
      {/if}
    </p>
    <div class="split">
      <div class="stack">
        {#if run.digest !== null}
          <!-- The text was written from chats of third parties: DigestThread draws it as text, never as markup. -->
          <DigestThread
            {texts}
            parts={[run.digest.text]}
            day={dayChip(run.finishedAt ?? run.startedAt, account.timezone, texts.locale, now)}
            time={formatTime(run.finishedAt ?? run.startedAt, account.timezone, texts.locale)}
            status="generated"
          />
        {:else if run.outcome === null}
          <div class="notice info measure">{t.runningRun}</div>
        {:else if run.outcome === 'empty'}
          <div class="notice info measure">{t.emptyRun}</div>
        {:else}
          <div class="notice info measure">{t.noDigest}</div>
        {/if}
      </div>
      <aside class="side">
        {#if reason !== null}
          <div class="notice bad" role="alert"><span>{reason}</span></div>
        {/if}
        {#if run.failedConversations.length > 0}
          <div class="notice warn">
            <b>{failedTitle(run.failedConversations.length)}</b>
            <ul>
              {#each run.failedConversations as chat (chat.id)}
                <li class="break">{fmt(texts.ui.text.labelled, { label: chat.name, value: failureReasonText(chat.reason, texts) })}</li>
              {/each}
            </ul>
          </div>
        {:else if run.outcome === 'committed'}
          <div class="notice ok"><div class="row"><Icon name="check" /><span>{t.allSummarized}</span></div></div>
        {/if}
      </aside>
    </div>
  {/if}
</div>
