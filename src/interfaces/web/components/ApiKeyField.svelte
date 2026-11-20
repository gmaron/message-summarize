<script lang="ts">
  import type { Snippet } from 'svelte'
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import {
    type ApiProvider,
    destinationId,
    destinationOf,
    type KeyStatus,
    type KeyStatuses,
    withTypedKey,
  } from '../lib/api-providers.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { hostOf } from '../lib/setup.js'
  import ProviderTest from './ProviderTest.svelte'

  // The API key of a provider (RNF-04). The key lives only in `typed`, in this component: it is sent once (to be saved, or to
  // be tried) and the field is emptied at once. It is never in the draft of a page, in the URL or in any storage, and the
  // daemon never gives it back: the page only knows whether there is one and where it comes from.
  let {
    api,
    texts,
    account,
    provider,
    baseUrl,
    idSuffix,
    lockedNote,
    test,
    beforeTest,
    onkeychange,
    afterKey,
  }: {
    api: Api
    texts: WebTexts
    account: string
    provider: ApiProvider
    /** The address the key is for (only OpenAI has one). The key goes under the name this address gives. */
    baseUrl: string
    idSuffix: string
    /** Why the key cannot be changed now (the address on screen is not the one saved): said instead of the buttons. */
    lockedNote?: string
    /** With it, "Test connection" is offered here, and it tries the key typed in the field without saving it. */
    test?: { body: { provider: string; options: Record<string, string>; consent?: string }; blocked: boolean }
    /** Shown between the key and the test (the agreement). */
    beforeTest?: Snippet
    /** Told when the key was saved or removed (the list of models depends on it). */
    onkeychange?: () => void
    /** Shown right under the key and its buttons, before the agreement and the test (the model is chosen there). */
    afterKey?: Snippet
  } = $props()

  const k = $derived(texts.ui.disclosure.keys)
  const destination = $derived(destinationOf(provider, baseUrl))
  const here = $derived(destinationId(destination))
  const host = $derived(destination.origin === null ? '' : (hostOf(destination.origin) ?? destination.origin))
  const destinationName = $derived(
    destination.kind === 'openai-compatible'
      ? fmt(k.destinations.compatible, { host })
      : k.destinations[destination.kind],
  )
  const inputId = $derived(`apikey-${idSuffix}`)

  let statuses: KeyStatuses | null = $state.raw(null)
  let typed = $state('')
  let busy = $state(false)
  let message: string | null = $state(null)
  let problem: string | null = $state(null)
  let cleared = $state(false)

  const status = $derived.by((): KeyStatus | null => (statuses === null ? null : statuses[destination.kind]))

  async function load(id: string) {
    try {
      statuses = await api.keys(id)
    } catch {
      statuses = null
    }
  }
  $effect(() => {
    const id = account
    untrack(() => load(id))
  })

  // A key typed is for the destination that was on screen. If the address changes, it is emptied instead of going elsewhere.
  let seen = untrack(() => here)
  $effect(() => {
    const now = here
    if (now === seen) return
    seen = now
    untrack(() => {
      cleared = typed !== ''
      typed = ''
      message = null
      problem = null
    })
  })

  const statusText = (value: KeyStatus | null): string => {
    if (value === null) return k.status.checking
    if (!value.present) return destination.kind === 'openai-compatible' ? k.status.noneCompatible : k.status.none
    if (value.source === 'env') return fmt(k.status.env, { name: value.name })
    return k.status[value.source]
  }

  async function save() {
    const key = typed.trim()
    if (key === '' || busy || lockedNote !== undefined) return
    busy = true
    message = null
    problem = null
    cleared = false
    try {
      const sending = api.saveKey(account, destination.kind, key)
      // The request holds the key now: the field is emptied whatever comes back (also when it fails).
      typed = ''
      const stored = await sending
      statuses = statuses === null ? null : { ...statuses, [destination.kind]: stored.key }
      if (stored.overriddenBy === 'env' && stored.key.present && stored.key.source === 'env') {
        message = fmt(k.overriddenEnv, { name: stored.key.name })
      } else if (stored.overriddenBy !== null) message = k.overriddenAccountFile
      else message = k.saved
      onkeychange?.()
    } catch (error) {
      problem = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      busy = false
    }
  }

  async function remove() {
    if (busy || lockedNote !== undefined) return
    busy = true
    message = null
    problem = null
    cleared = false
    try {
      const removed = await api.removeKey(account, destination.kind)
      statuses = statuses === null ? null : { ...statuses, [destination.kind]: removed.key }
      message = removed.removed ? k.removed : k.stillInForce
      onkeychange?.()
    } catch (error) {
      problem = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      busy = false
    }
  }

  const testBody = $derived(test === undefined ? null : withTypedKey(test.body, provider, destination, typed))
</script>

<div class="stack-sm">
  <div class="field">
    <label for={inputId}>{k.label}</label>
    <input
      id={inputId}
      type="password"
      value={typed}
      oninput={(event) => {
        typed = event.currentTarget.value
        cleared = false
      }}
      onkeydown={(event) => {
        // Enter here saves the key, not the page's form.
        if (event.key === 'Enter') {
          event.preventDefault()
          void save()
        }
      }}
      autocomplete="new-password"
      data-1p-ignore
      data-lpignore="true"
      autocapitalize="off"
      spellcheck="false"
      placeholder={k.placeholder}
      disabled={busy || lockedNote !== undefined}
      aria-describedby="{inputId}-hint {inputId}-status"
    />
    <span class="hint" id="{inputId}-hint">{fmt(k.hint, { destination: destinationName })}</span>
    {#if destination.kind === 'openai-compatible'}
      <span class="hint">{fmt(k.compatibleNote, { host })}</span>
    {/if}
  </div>
  <p class="small" id="{inputId}-status">{statusText(status)}</p>
  {#if lockedNote !== undefined}
    <p class="muted small">{lockedNote}</p>
  {/if}
  <div class="cluster">
    <button
      type="button"
      class="btn"
      onclick={save}
      disabled={busy || typed.trim() === '' || lockedNote !== undefined}
    >
      {busy ? k.working : status?.present === true ? k.replace : k.save}
    </button>
    {#if status?.present === true}
      <button type="button" class="btn quiet danger" onclick={remove} disabled={busy || lockedNote !== undefined}>
        {k.remove}
      </button>
    {/if}
  </div>
  <div aria-live="polite">
    {#if message !== null}
      <p class="notice ok small" role="status">{message}</p>
    {/if}
    {#if cleared}
      <p class="notice info small" role="status">{k.clearedNote}</p>
    {/if}
    {#if problem !== null}
      <p class="notice bad small" role="alert">{problem}</p>
    {/if}
  </div>
  {#if afterKey !== undefined}
    {@render afterKey()}
  {/if}
  {#if beforeTest !== undefined}
    {@render beforeTest()}
  {/if}
  {#if test !== undefined && testBody !== null}
    <ProviderTest {api} {texts} body={testBody} blocked={test.blocked} onsent={() => (typed = '')} />
  {/if}
</div>
