<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import ConfigNotice from '../components/ConfigNotice.svelte'
  import ConfirmDialog from '../components/ConfirmDialog.svelte'
  import Icon from '../components/Icon.svelte'
  import { accountActions } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import {
    clientProblem,
    differsFromOriginal,
    isDirty,
    nameNote,
    normalizeText,
    type PromptProblem,
    problemOf,
    problemText,
  } from '../lib/prompt.js'
  import { hrefOf } from '../lib/router.js'
  import type { AccountView, PromptView } from '../lib/types.js'

  // The instructions the model receives with every conversation. The text is the user's own: it lives in a text box.
  let {
    api,
    texts,
    account,
    ondirty,
  }: {
    api: Api
    texts: WebTexts
    account: AccountView
    /** Tells the page whether the text has changes that are not saved (leaving then asks first). */
    ondirty: (dirty: boolean) => void
  } = $props()
  const usable = $derived(accountActions(account).prompt)

  const t = $derived(texts.ui.prompt)
  // Only the id matters: `account` is a new object on every `accounts` event and the text being edited must not be reloaded.
  const accountId = $derived(account.id)
  let loaded = $state.raw<PromptView | null>(null)
  let draft = $state('')
  let loadError: string | null = $state(null)
  let failure: string | null = $state(null)
  let refused: PromptProblem | null = $state.raw(null)
  let notice: string | null = $state(null)
  let busy: 'saving' | 'restoring' | null = $state(null)
  let confirming = $state(false)

  // What is wrong with the text as typed: the same rules as the daemon, for instant feedback. The daemon decides.
  const problem = $derived(loaded === null ? null : clientProblem(draft, loaded.maxLength))
  const dirty = $derived(loaded !== null && isDirty(draft, loaded))
  const differs = $derived(loaded !== null && differsFromOriginal(draft, loaded))
  const shown = $derived(problem ?? refused)

  function show(view: PromptView) {
    loaded = view
    draft = normalizeText(view.text)
  }

  async function load(id: string) {
    try {
      show(await api.prompt(id))
      loadError = null
    } catch (error) {
      loadError = error instanceof ApiError ? error.code : 'internal'
    }
  }
  $effect(() => {
    const id = accountId
    if (untrack(() => usable)) untrack(() => load(id))
  })

  // Closing the tab, or going to another page, with a text that is not saved asks first.
  $effect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', guard)
    ondirty(true)
    return () => {
      window.removeEventListener('beforeunload', guard)
      ondirty(false)
    }
  })

  function clearMessages() {
    failure = null
    refused = null
    notice = null
  }

  /** Saves the text; true when it was saved (or there was nothing to save). */
  async function save(): Promise<boolean> {
    if (loaded === null || problem !== null) return false
    clearMessages()
    if (!dirty && loaded.error === undefined) return true
    busy = 'saving'
    try {
      show(await api.savePrompt(accountId, draft))
      notice = t.saved
      return true
    } catch (error) {
      refused = problemOf(error)
      if (refused === null) failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
      return false
    } finally {
      busy = null
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (loaded !== null && !dirty && loaded.error === undefined) {
      clearMessages()
      failure = t.noChanges
      return
    }
    await save()
  }

  // The preview uses the saved prompt: what is typed is saved first.
  async function tryPreview() {
    if (await save()) {
      ondirty(false)
      location.hash = hrefOf({ name: 'preview', id: accountId })
    }
  }

  async function restore() {
    confirming = false
    clearMessages()
    busy = 'restoring'
    try {
      const view = await api.restorePrompt(accountId)
      show(view)
      notice = view.source === 'installation' ? t.restoredInherited : t.restored
    } catch (error) {
      failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      busy = null
    }
  }
</script>

<div class="page-inner">
  <div class="crumb">
    <a href={hrefOf({ name: 'account', id: accountId, tab: 'ajustes' })}><Icon name="back" />{fmt(t.back, { account: accountId })}</a>
  </div>
  <div class="head">
    <h1>{t.title}</h1>
    {#if loaded !== null}
      <span class="pill {differs ? 'busy' : 'idle'}">{differs ? t.differs : t.sameAsOriginal}</span>
    {/if}
  </div>

  {#if !usable}
    <ConfigNotice {texts} {account} />
  {:else if loadError !== null}
    <div class="notice bad" role="alert">{errorText(loadError, texts)}</div>
  {:else if loaded === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <div class="split">
      <form class="stack" onsubmit={submit}>
        {#if loaded.error === 'promptFile'}
          <p class="notice warn" role="alert">{t.fileMissing}</p>
        {/if}
        <div class="field">
          <label for="prompt-text">{t.label}</label>
          <textarea
            id="prompt-text"
            spellcheck="false"
            autocomplete="off"
            bind:value={draft}
            oninput={clearMessages}
            aria-describedby="prompt-info prompt-state"
            aria-invalid={shown !== null}
          ></textarea>
          <span class="hint" id="prompt-info">{nameNote(loaded, texts)}</span>
          <span class="hint cluster" id="prompt-state">
            <span>{t.sources[loaded.source]}</span>
            <span class="num count">{fmt(t.counter, { count: draft.length, max: loaded.maxLength })}</span>
          </span>
          {#if shown !== null}
            <span class="err" role="alert">{problemText(shown, texts, loaded.maxLength)}</span>
          {/if}
        </div>

        {#if failure !== null}
          <p class="notice warn" role="alert">{failure}</p>
        {/if}
        {#if notice !== null}
          <p class="notice ok" role="status">{notice}</p>
        {/if}

        <div class="cluster">
          <button type="submit" class="btn primary" disabled={busy !== null || problem !== null}>
            {busy === 'saving' ? t.saving : t.save}
          </button>
          <button type="button" class="btn" disabled={busy !== null || problem !== null} onclick={tryPreview}>
            <Icon name="eye" />{t.preview}
          </button>
          <button type="button" class="btn quiet" disabled={busy !== null || loaded.source !== 'account'} onclick={() => (confirming = true)}>
            {busy === 'restoring' ? t.restoring : t.restore}
          </button>
        </div>
      </form>
      <aside class="side">
        <div class="notice info">
          <b>{t.formatTitle}</b>
          <span>{t.formatNote}</span>
        </div>
        <p class="small muted">{t.intro}</p>
      </aside>
    </div>
  {/if}
</div>

{#if confirming}
  <ConfirmDialog
    title={t.restoreTitle}
    confirmLabel={t.restoreYes}
    cancelLabel={t.restoreNo}
    onconfirm={restore}
    oncancel={() => (confirming = false)}
  >
    <p>{t.restoreConfirm}</p>
    <p class="small">{t.restoreInherits}</p>
  </ConfirmDialog>
{/if}

<style>
  .count {
    margin-left: auto;
  }
</style>
