<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { accountActions, fixKind, retryWaitUntil } from '../lib/accounts.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import { hrefOf } from '../lib/router.js'
  import type { AccountView } from '../lib/types.js'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Icon from './Icon.svelte'

  // The action that fixes what is wrong with an account, as the daemon allows it (`accountActions`): link again, retry
  // (after a question, because a refused retry can block the account for longer), link, or look at the settings.
  let {
    account,
    texts,
    controller,
    now,
    small = false,
    open = false,
  }: {
    account: AccountView
    texts: WebTexts
    controller: Controller
    /** The shared clock: when a retry becomes possible is worked out from it. */
    now: number
    small?: boolean
    /** When nothing is wrong, offer to open the account instead of nothing. */
    open?: boolean
  } = $props()

  const ui = $derived(texts.ui)
  const kind = $derived(fixKind(account))
  const actions = $derived(accountActions(account))
  const id = $derived(account.id)

  const waitUntil = $derived(retryWaitUntil(account, now))
  let confirming = $state(false)
  let retryError: string | null = $state(null)

  async function retry() {
    confirming = false
    retryError = await controller.retry(id)
  }
</script>

{#if kind === 'relink'}
  <a class="btn primary" class:sm={small} href={hrefOf({ name: 'link', id })}>{ui.actions.relink}</a>
{:else if kind === 'retry'}
  <button type="button" class="btn primary" class:sm={small} disabled={waitUntil !== null} onclick={() => (confirming = true)}>
    {ui.actions.retry}
  </button>
{:else if kind === 'link'}
  <a class="btn primary" class:sm={small} href={hrefOf({ name: 'link', id })}><Icon name="link" />{ui.actions.link}</a>
{:else if kind === 'settings'}
  <a class="btn" class:sm={small} href={hrefOf({ name: 'account', id, tab: 'ajustes' })}>{ui.account.fixSettings}</a>
{:else if open}
  <a class="btn" class:sm={small} href={hrefOf({ name: 'account', id, tab: 'resumen' })}>{ui.actions.open}</a>
{/if}
{#if waitUntil !== null && actions.retry}
  <span class="small muted">{fmt(ui.account.retryAvailable, { when: formatDateTime(waitUntil, account.timezone, texts.locale) })}</span>
{/if}
{#if retryError !== null}
  <span class="small bad-text" role="alert">{errorText(retryError, texts)}</span>
{/if}
{#if confirming}
  <ConfirmDialog
    title={ui.retryConfirm.title}
    confirmLabel={ui.retryConfirm.yes}
    cancelLabel={ui.retryConfirm.no}
    onconfirm={retry}
    oncancel={() => (confirming = false)}
  >
    <p>{ui.retryConfirm.confirm}</p>
  </ConfirmDialog>
{/if}
