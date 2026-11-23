<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import DigestThread from '../components/DigestThread.svelte'
  import FixAction from '../components/FixAction.svelte'
  import Icon from '../components/Icon.svelte'
  import { accountActions, fixKind, hasProblem, isDigestRunning, pillOf, pillText } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { blockedText, digestMessage, errorText } from '../lib/digest.js'
  import { dayChip, formatDateTime, formatTime, whenText, whenTitle } from '../lib/format.js'
  import { providersText } from '../lib/history.js'
  import { fmt } from '../lib/i18n.js'
  import { type LastDigest, loadLastDigest } from '../lib/last-digest.js'
  import { hrefOf } from '../lib/router.js'
  import { scheduleSummary } from '../lib/schedules.js'
  import { issueReason, optionLabel } from '../lib/settings.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, SchedulesView } from '../lib/types.js'

  // Resumen: the last digest as a bubble (the one reader), and on the side what is wrong, what comes next and what can be done.
  let {
    app,
    api,
    texts,
    controller,
    account,
    accounts,
    now,
  }: {
    app: AppState
    api: Api
    texts: WebTexts
    controller: Controller
    account: AccountView
    accounts: readonly AccountView[]
    /** The shared clock. */
    now: number
  } = $props()

  const ui = $derived(texts.ui)
  const id = $derived(account.id)
  const digest = $derived(app.digests[id])
  const actions = $derived(accountActions(account))
  const running = $derived(isDigestRunning(digest))
  const queued = $derived(digest?.kind === 'deferred')
  const feedback = $derived(digest === undefined ? null : digestMessage(digest, texts))
  const settled = $derived(digest !== undefined && !running && !queued)
  const problem = $derived(fixKind(account) !== null)
  const others = $derived(accounts.filter((other) => other.id !== id && hasProblem(other)))

  // `undefined` while it loads, `null` when the account has no digest yet.
  let last: LastDigest | null | undefined = $state.raw(undefined)
  let loadError: string | null = $state(null)
  let fresh = $state(false)
  let schedules: SchedulesView | null = $state.raw(null)
  let ticket = 0

  async function load(account: string) {
    const mine = ++ticket
    try {
      const next = await loadLastDigest(api, account)
      if (mine !== ticket) return
      // A digest that arrives while the page is open comes in with a small motion; the first one on the page does not.
      fresh = last !== undefined && last !== null && next !== null && next.run.id !== last.run.id
      last = next
      loadError = null
    } catch (error) {
      if (mine !== ticket) return
      loadError = error instanceof ApiError ? error.code : 'internal'
      if (last === undefined) last = null
    }
  }

  $effect(() => {
    const account = id
    last = undefined
    fresh = false
    untrack(() => {
      void load(account)
      api
        .schedules(account)
        .then((view) => (schedules = view))
        .catch(() => (schedules = null))
    })
    // The daemon says that the history has a new run: the last digest is asked for again.
    return controller.onHistory((changed) => {
      if (changed === account) void load(account)
    })
  })

  // A digest that ends: what it produced is asked for (the history event may come first or later; both ask).
  let previous: string | undefined
  /** When the digest asked for now started in this session: only a digest made after it can be said to have arrived. */
  let startedAt = 0
  $effect(() => {
    const kind = digest?.kind
    const was = previous
    previous = kind
    if ((kind === 'requesting' || kind === 'started') && was !== 'requesting' && was !== 'started') startedAt = Date.now()
    if ((kind === 'done' || kind === 'empty') && was !== undefined && was !== kind) untrack(() => void load(id))
  })

  const when = (ms: number): string => whenText(ms, account.timezone, texts.locale, now)
  const todayChip = $derived(dayChip(now, account.timezone, texts.locale, now))
  // (`$derived.by`: the functions see the state as it is now, not as it was when it was declared.)
  const lastDay = $derived.by(() => (last === null || last === undefined ? '' : dayChip(last.at, account.timezone, texts.locale, now)))
  const total = $derived.by(() => (last === null || last === undefined ? 0 : last.run.summarized + last.run.failed))
  const providers = $derived.by(() => (last === null || last === undefined ? '' : providersText(last.run.providers, texts)))
  const closed = $derived(account.state === 'blocked')
  // Two sea-green ticks only after the daemon said `done` for a digest asked for in this session; the history says "made".
  const delivered = $derived.by(() => digest?.kind === 'done' && last !== null && last !== undefined && startedAt > 0 && last.at >= startedAt - 60_000)
  const nextText = $derived(
    account.nextRun !== null
      ? whenTitle(account.nextRun, account.timezone, texts.locale, now)
      : closed
        ? ui.overview.paused
        : ui.account.noSchedules,
  )
  const summary = $derived.by(() => (schedules === null ? '' : scheduleSummary(schedules.schedules, texts)))
  const noSchedules = $derived.by(() => schedules !== null && schedules.schedules.length === 0)
  const toneOf = { ok: 'ok', warn: 'warn', error: 'bad', working: 'info' } as const
</script>

<div class="page-inner">
  <AccountHeader {account} {texts} tab="resumen" {running} />
  <div class="split">
    <section class="stack" aria-labelledby="last-title">
      <h2 id="last-title" class="sr">{texts.ui.account.lastDigest}</h2>
      {#if last !== undefined && last !== null}
        <p class="meta-line">
          <span>{fmt(ui.overview.lastDigest, { when: when(last.at) })}</span>
          <span>{total === 1 ? ui.overview.conversationsOne : fmt(ui.overview.conversations, { count: total })}</span>
          {#if total > 0}<span>{providers}</span>{/if}
          <a href={hrefOf({ name: 'account', id, tab: 'historial' })}>{ui.overview.seeHistory}</a>
        </p>
      {/if}
      {#if running || queued}
        <DigestThread {texts} parts={[]} day={todayChip} time={formatTime(now, account.timezone, texts.locale)} status={queued ? 'queued' : 'pending'} skeleton={!queued} />
      {/if}
      {#if last === undefined}
        <div role="status"><span class="sr">{ui.loading}</span></div>
        <DigestThread {texts} parts={[]} day="" time="" status="pending" skeleton />
      {:else if last !== null}
        <DigestThread
          {texts}
          parts={[last.text]}
          day={(running || queued) && lastDay === todayChip ? '' : lastDay}
          time={formatTime(last.at, account.timezone, texts.locale)}
          status={delivered ? 'sent' : 'generated'}
          {fresh}
        />
      {:else if loadError !== null}
        <div class="notice bad" role="alert">
          <span>{errorText(loadError, texts)}</span>
          <div class="acts"><button type="button" class="btn sm" onclick={() => load(id)}>{ui.retry}</button></div>
        </div>
      {:else if !running && !queued}
        <div class="panel measure">
          <h2>{account.lastDigest === null ? ui.overview.emptyTitle : ui.overview.recentTitle}</h2>
          <p class="muted">{account.lastDigest === null ? ui.overview.emptyText : ui.overview.recentText}</p>
        </div>
      {/if}
    </section>

    <aside class="side" aria-label={ui.actions.digestNow}>
      {#if problem}
        <div class="notice bad" role="alert">
          <div class="row">
            <Icon name="alert" />
            <div class="stack-sm">
              {#if !account.configValid}
                <b>{ui.account.invalidConfig}</b>
                {#if account.configIssues.length > 0}
                  <span>{ui.account.configIssues}</span>
                  <ul>
                    {#each account.configIssues as issue (`${issue.option}:${issue.code}`)}
                      <li>{fmt(ui.settings.issue, { option: optionLabel(issue.option, texts), reason: issueReason(issue, texts) })}</li>
                    {/each}
                  </ul>
                {/if}
              {:else}
                <b>{account.blockedReason === null ? pillText(pillOf(account, false).key, texts) : blockedText(account.blockedReason, texts)}</b>
                {#if account.state === 'blocked' && account.blockedAt !== null}
                  <span>{fmt(ui.account.blockedSince, { when: formatDateTime(account.blockedAt, account.timezone, texts.locale) })}</span>
                {/if}
                {#if account.fix === 'relink'}<span>{ui.account.closedNote}</span>{/if}
              {/if}
            </div>
          </div>
          <div class="acts"><FixAction {account} {texts} {controller} {now} /></div>
        </div>
      {/if}
      {#each others as other (other.id)}
        <div class="notice bad compact">
          <div class="row">
            <Icon name="alert" />
            <span><b>{fmt(ui.text.labelled, { label: other.id, value: pillText(pillOf(other, false).key, texts) })}</b></span>
            <FixAction account={other} {texts} {controller} {now} small />
          </div>
        </div>
      {/each}

      <!-- One live region from the start: only its text changes as the digest goes on. -->
      <div class="sr" role="status" aria-live="polite">{feedback === null ? '' : feedback.text}</div>
      {#if running || queued}
        <div class="panel">
          <h3>{ui.overview.progressTitle}</h3>
          {#if running}
            <div class="progress"><progress class="bar" aria-label={ui.overview.progressTitle}></progress></div>
          {/if}
          {#if feedback !== null}<span class="small muted">{feedback.text}</span>{/if}
        </div>
      {:else if settled && feedback !== null}
        <div class="notice {toneOf[feedback.tone]}">{feedback.text}</div>
      {/if}

      <div class="panel">
        <span class="small muted">{ui.overview.next}</span>
        <span class="big num">{nextText}</span>
        {#if summary !== ''}<span class="small muted">{summary}</span>{/if}
        <a class="small" href={hrefOf({ name: 'account', id, tab: 'horarios' })}>
          {noSchedules ? ui.overview.addSchedules : ui.overview.changeSchedules}
        </a>
      </div>
      <button type="button" class="btn primary block" disabled={!actions.digest || running || queued} onclick={() => controller.digestNow(id)}>
        <Icon name="send" />{ui.actions.digestNow}
      </button>
      <a class="btn block" href={hrefOf({ name: 'account', id, tab: 'pedir' })}><Icon name="mic" />{texts.ui.tabs.ask}</a>
      {#if actions.preview}
        <a class="btn block" href={hrefOf({ name: 'preview', id })}><Icon name="eye" />{ui.actions.preview}</a>
      {:else}
        <button type="button" class="btn block" disabled><Icon name="eye" />{ui.actions.preview}</button>
      {/if}
      <p class="small muted">{account.fix === 'relink' ? ui.overview.needsRelink : ui.overview.previewHelp}</p>
    </aside>
  </div>
</div>
