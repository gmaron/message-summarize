<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { accountActions, badgeOf, retryWaitUntil } from '../lib/accounts.js'
  import { blockedText, digestMessage, errorText, stateText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import { issueReason, optionLabel } from '../lib/settings.js'
  import type { DigestUi } from '../lib/state.js'
  import type { AccountView } from '../lib/types.js'

  let {
    account,
    texts,
    digest,
    retryError,
    ondigest,
    onpreview,
    onschedules,
    onconversations,
    onhistory,
    onsettings,
    onprompt,
    onlink,
    onretry,
  }: {
    account: AccountView
    texts: WebTexts
    digest: DigestUi | undefined
    retryError: string | null
    ondigest: () => void
    onpreview: () => void
    onschedules: () => void
    onconversations: () => void
    onhistory: () => void
    onsettings: () => void
    onprompt: () => void
    onlink: () => void
    onretry: () => void
  } = $props()

  const ui = $derived(texts.ui)
  const badge = $derived(badgeOf(account))
  const actions = $derived(accountActions(account))
  const when = (ms: number) => formatDateTime(ms, account.timezone, texts.locale)
  const feedback = $derived(digest === undefined ? null : digestMessage(digest, texts))
  const busy = $derived(digest?.kind === 'requesting')

  // When retrying becomes possible is a matter of the clock: it is looked at again every half minute.
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })
  const waitUntil = $derived(retryWaitUntil(account, now))
  // Retrying asks twice: the second click is on the confirmation.
  let confirming = $state(false)
</script>

<article class="card" aria-labelledby="account-{account.id}">
  <header>
    <h3 id="account-{account.id}">{account.id}</h3>
    <span class="badge {badge}">{stateText(badge, texts)}</span>
  </header>

  {#if !account.configValid}
    <div class="note error">
      <p>{ui.account.invalidConfig}</p>
      {#if account.configIssues.length > 0}
        <p>{ui.account.configIssues}</p>
        <ul>
          {#each account.configIssues as issue (`${issue.option}:${issue.code}`)}
            <li>{fmt(ui.settings.issue, { option: optionLabel(issue.option, texts), reason: issueReason(issue, texts) })}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if account.state === 'blocked' && account.blockedReason !== null}
    <p class="note warn">{blockedText(account.blockedReason, texts)}</p>
  {/if}
  {#if account.state === 'blocked' && account.blockedAt !== null}
    <p class="muted small">{fmt(ui.account.blockedSince, { when: when(account.blockedAt) })}</p>
  {/if}
  {#if waitUntil !== null && actions.retry}
    <p class="muted small">{fmt(ui.account.retryAvailable, { when: when(waitUntil) })}</p>
  {/if}

  <dl>
    <div>
      <dt>{ui.account.number}</dt>
      <dd>{account.maskedNumber ?? ui.account.noNumber}</dd>
    </div>
    <div>
      <dt>{ui.account.lastDigest}</dt>
      <dd>{account.lastDigest === null ? ui.account.never : when(account.lastDigest)}</dd>
    </div>
    <div>
      <dt>{ui.account.nextRun}</dt>
      <dd>{account.nextRun === null ? ui.account.noSchedules : when(account.nextRun)}</dd>
    </div>
    <div>
      <dt>{ui.account.timezone}</dt>
      <dd>{account.timezone}</dd>
    </div>
  </dl>

  {#if feedback !== null}
    <p class="note {feedback.tone}" role="status">{feedback.text}</p>
  {/if}
  {#if retryError !== null}
    <p class="note error" role="alert">{errorText(retryError, texts)}</p>
  {/if}

  {#if confirming}
    <div class="note warn" role="alertdialog" aria-label={ui.actions.retry}>
      <p>{ui.retryConfirm.confirm}</p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          onclick={() => {
            confirming = false
            onretry()
          }}
        >
          {ui.retryConfirm.yes}
        </button>
        <button type="button" onclick={() => (confirming = false)}>{ui.retryConfirm.no}</button>
      </div>
    </div>
  {:else}
    <div class="actions">
      <button type="button" class="primary" disabled={!actions.digest || busy} onclick={ondigest}>
        {ui.actions.digestNow}
      </button>
      <button type="button" disabled={!actions.preview} onclick={onpreview}>{ui.actions.preview}</button>
      <button type="button" disabled={!actions.schedules} onclick={onschedules}>{ui.actions.schedules}</button>
      <button type="button" disabled={!actions.conversations} onclick={onconversations}>
        {ui.actions.conversations}
      </button>
      <button type="button" disabled={!actions.history} onclick={onhistory}>{ui.actions.history}</button>
      <button type="button" disabled={!actions.settings} onclick={onsettings}>{ui.actions.settings}</button>
      <button type="button" disabled={!actions.prompt} onclick={onprompt}>{ui.actions.prompt}</button>
      {#if actions.link}
        <button type="button" onclick={onlink}>{ui.actions.link}</button>
      {/if}
      {#if actions.relink}
        <button type="button" onclick={onlink}>{ui.actions.relink}</button>
      {/if}
      {#if actions.retry}
        <button type="button" disabled={waitUntil !== null} onclick={() => (confirming = true)}>
          {ui.actions.retry}
        </button>
      {/if}
    </div>
  {/if}
</article>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem;
    display: grid;
    gap: 0.75rem;
    height: 100%;
    align-content: start;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  h3 {
    font-size: 1.1rem;
    overflow-wrap: anywhere;
  }

  p {
    margin: 0;
  }

  .note ul {
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
  }

  .small {
    font-size: 0.85rem;
  }

  .badge {
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    background: var(--neutral-bg);
    white-space: nowrap;
  }

  .badge.connected {
    background: var(--ok-bg);
    color: var(--ok);
  }

  .badge.connecting,
  .badge.reconnecting,
  .badge.linking {
    background: var(--warn-bg);
    color: var(--warn);
  }

  .badge.blocked {
    background: var(--error-bg);
    color: var(--error);
  }

  dl {
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  dl div {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    text-align: right;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
