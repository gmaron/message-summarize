<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
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
  import type { AccountView, PromptView } from '../lib/types.js'
  import Modal from './Modal.svelte'

  let {
    api,
    texts,
    account,
    onclose,
    onpreview,
  }: { api: Api; texts: WebTexts; account: AccountView; onclose: () => void; onpreview: () => void } = $props()

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
    untrack(() => load(id))
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

  async function saveAndPreview() {
    if (await save()) onpreview()
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

  const shown = $derived(problem ?? refused)
</script>

<Modal title={fmt(t.title, { account: account.id })} closeLabel={texts.ui.close} {onclose}>
  {#if loadError !== null}
    <p class="note error" role="alert">{errorText(loadError, texts)}</p>
  {:else if loaded === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <p class="muted">{t.intro}</p>

    {#if loaded.error === 'promptFile'}
      <p class="note warn" role="alert">{t.fileMissing}</p>
    {/if}

    <form onsubmit={submit}>
      <div class="field">
        <label for="prompt-text">{t.label}</label>
        <textarea
          id="prompt-text"
          rows="16"
          spellcheck="false"
          autocomplete="off"
          bind:value={draft}
          oninput={clearMessages}
          aria-describedby="prompt-info prompt-state"
          aria-invalid={shown !== null}
        ></textarea>
        <p class="info muted" id="prompt-info">
          {nameNote(loaded, texts)}
          {t.formatNote}
        </p>
        <p class="state" id="prompt-state">
          <span class="badge {differs ? 'differs' : 'same'}">{differs ? t.differs : t.sameAsOriginal}</span>
          <span class="muted">{t.sources[loaded.source]}</span>
          <span class="muted counter">{fmt(t.counter, { count: draft.length, max: loaded.maxLength })}</span>
        </p>
        {#if shown !== null}
          <p class="problem" role="alert">{problemText(shown, texts, loaded.maxLength)}</p>
        {/if}
      </div>

      {#if failure !== null}
        <p class="note warn" role="alert">{failure}</p>
      {/if}
      {#if notice !== null}
        <p class="note ok" role="status">{notice}</p>
      {/if}

      {#if confirming}
        <div class="note warn" role="alertdialog" aria-label={t.restore}>
          <p>{t.restoreConfirm}</p>
          <p class="muted">{t.restoreInherits}</p>
          <div class="row-buttons">
            <button type="button" class="danger" onclick={restore}>{t.restoreYes}</button>
            <button type="button" onclick={() => (confirming = false)}>{t.restoreNo}</button>
          </div>
        </div>
      {:else}
        <div class="row-buttons">
          <button type="submit" class="primary" disabled={busy !== null || problem !== null}>
            {busy === 'saving' ? t.saving : t.save}
          </button>
          <button type="button" disabled={busy !== null || problem !== null} onclick={saveAndPreview}>
            {t.preview}
          </button>
          <button
            type="button"
            disabled={busy !== null || loaded.source !== 'account'}
            onclick={() => (confirming = true)}
          >
            {busy === 'restoring' ? t.restoring : t.restore}
          </button>
          <button type="button" onclick={onclose}>{texts.ui.close}</button>
        </div>
      {/if}
    </form>
  {/if}
</Modal>

<style>
  p {
    margin: 0;
  }

  form {
    display: grid;
    gap: 1rem;
    margin-top: 0.75rem;
  }

  .field {
    display: grid;
    gap: 0.35rem;
  }

  label {
    font-weight: 600;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9rem;
    line-height: 1.45;
    resize: vertical;
    min-height: 10rem;
  }

  .info,
  .state {
    font-size: 0.85rem;
  }

  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
  }

  .counter {
    margin-left: auto;
  }

  .badge {
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    font-weight: 600;
    background: var(--neutral-bg);
  }

  .badge.differs {
    background: var(--warn-bg);
    color: var(--warn);
  }

  .problem {
    color: var(--error);
    font-size: 0.9rem;
  }

  .row-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
