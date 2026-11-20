<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import type { Api } from '../lib/api.js'
  import { fmt } from '../lib/i18n.js'
  import { optionText, pickerState } from '../lib/models.js'
  import type { ModelProviderName, ModelsView } from '../lib/types.js'

  // The model of a provider, chosen from a list the daemon gives (Claude Code's aliases, what Ollama has installed, or what the
  // provider answers to a request made with the saved key). Nobody types a model: only a compatible server that gives no list
  // lets a name be typed, and it says so. The list is asked again when `reload` changes (a key was saved) or on "Look again".
  let {
    api,
    texts,
    account,
    provider,
    value,
    onchange,
    label,
    hint,
    id,
    baseUrl,
    reload = 0,
    describedby,
    bare = false,
    typingOnly = false,
    consent,
    labelledby,
    inherit = false,
  }: {
    api: Api
    texts: WebTexts
    account: string
    provider: ModelProviderName
    value: string
    onchange: (model: string) => void
    label: string
    hint?: string
    /** The id of the control (the label points at it). */
    id: string
    /** The address of Ollama on screen, which may not be saved yet. */
    baseUrl?: string
    /** Changes when the list has to be asked again (a key was saved or removed). */
    reload?: number
    /** Other elements that describe the control (the tag of the source in the settings). */
    describedby?: string
    /** No label and no hint of its own (the row of the settings has them): only the control and what it says. */
    bare?: boolean
    /** The address of a compatible server is not saved yet: it cannot be asked, so a name may be typed until it is. */
    typingOnly?: boolean
    /** The agreement ticked for an Ollama that is not on this machine (its consent key), so its models may be asked. */
    consent?: string
    /** With `bare`: the element that names the control (the title of the row). */
    labelledby?: string
    /** The address field was emptied: the daemon asks the server the installation gives, not the account's old one. */
    inherit?: boolean
  } = $props()

  const m = $derived(texts.ui.models)
  let view: ModelsView | null = $state.raw(null)
  let ticket = 0
  let started = false

  async function load(refresh: boolean) {
    const mine = ++ticket
    view = null
    try {
      const answer = await api.models(account, provider, {
        refresh,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(consent === undefined ? {} : { consent }),
        ...(inherit ? { inherit: true } : {}),
      })
      if (mine === ticket) view = answer
    } catch {
      // The daemon could not answer at all (an invalid configuration, it is gone): a list that failed.
      if (mine === ticket) view = { provider, source: 'live', models: [], error: 'failed' }
    }
  }

  // Asked when the provider, the account, the address on screen or `reload` change.
  $effect(() => {
    void [account, provider, baseUrl, reload, consent, inherit]
    if (typingOnly) return
    // Typing an address asks once the user pauses, not at every key.
    const wait = started ? 400 : 0
    started = true
    const timer = setTimeout(() => untrack(() => load(false)), wait)
    return () => clearTimeout(timer)
  })

  const picker = $derived(
    typingOnly
      ? { kind: 'typing' as const, options: [], selected: value, fallback: false, foreign: false, reason: null }
      : pickerState(provider, view, value),
  )
  const hintId = $derived(`${id}-hint`)
  const nameId = $derived(`${id}-name`)
  const noteId = $derived(`${id}-note`)
  const described = $derived(
    [bare ? undefined : hintId, picker.kind === 'needsKey' ? noteId : undefined, describedby]
      .filter((one) => one !== undefined)
      .join(' ') || undefined,
  )
  /** What an Ollama with no list, or OpenAI or Gemini with an error, says: the cause and what to do. */
  const problemText = $derived.by((): string => {
    switch (picker.reason) {
      case 'invalidAddress':
        return m.invalidAddress
      case 'consentRequired':
        return m.needsConsent
      case 'rejected':
        return m.rejected
      case 'unreachable':
        return picker.kind === 'empty' ? m.emptyOllama : m.listUnreachable
      case 'failed':
        return m.listFailed
      default:
        return m.emptyOllama
    }
  })
  const note = $derived.by((): string | null => {
    if (picker.kind === 'needsKey') return m.needsKey
    if (picker.reason === 'rejected') return m.rejected
    if (picker.fallback) return m.fallback
    return null
  })
</script>

<div class="field">
  {#if picker.kind === 'typing'}
    {#if !bare}<label for={id}>{m.typingLabel}</label>{/if}
    <input
      {id}
      type="text"
      {value}
      oninput={(event) => onchange(event.currentTarget.value)}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-labelledby={bare ? labelledby : undefined}
      aria-describedby={described}
    />
    <span class="hint" id={hintId}>{typingOnly ? m.typingUnsaved : m.typingHint}</span>
    {#if !typingOnly}
      <div class="cluster">
        <button type="button" class="btn sm" onclick={() => load(true)}>{m.retry}</button>
      </div>
    {/if}
  {:else if picker.kind === 'empty' || picker.kind === 'failed'}
    <!-- There is no control to point a label at: a group with a name, the problem and the way to ask again. -->
    {#if !bare}<span class="lab" id={nameId}>{label}</span>{/if}
    <div class="stack-sm" role="group" aria-labelledby={bare ? labelledby : nameId}>
      <p class="notice warn small" role="status" id={hintId}>{problemText}</p>
      <div class="cluster">
        <button type="button" class="btn sm" onclick={() => load(true)}>{m.retry}</button>
      </div>
    </div>
  {:else}
    {#if !bare}<label for={id}>{label}</label>{/if}
    <select
      {id}
      value={picker.selected}
      disabled={picker.kind === 'loading' || picker.kind === 'needsKey'}
      onchange={(event) => onchange(event.currentTarget.value)}
      aria-labelledby={bare ? labelledby : undefined}
      aria-describedby={described}
    >
      {#if picker.kind === 'loading'}
        <option value="">{m.loading}</option>
      {:else}
        <option value="">{provider === 'claude-cli' ? m.byDefault : m.choose}</option>
        {#each picker.options as option (option.id)}
          <option value={option.id}>{optionText(provider, option)}</option>
        {/each}
      {/if}
    </select>
    {#if !bare}<span class="hint" id={hintId}>{hint ?? ''}</span>{/if}
    {#if note !== null}
      <p class="small muted" role="status" id={noteId}>{note}</p>
    {/if}
    {#if picker.foreign}
      <p class="notice warn small" role="status">{fmt(m.foreign, { model: value })}</p>
    {/if}
    {#if picker.fallback || picker.reason === 'rejected'}
      <div class="cluster">
        <button type="button" class="btn sm" onclick={() => load(true)}>{m.retry}</button>
      </div>
    {/if}
  {/if}
</div>
