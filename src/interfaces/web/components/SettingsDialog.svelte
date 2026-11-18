<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { hostOf, needsConsent } from '../lib/setup.js'
  import {
    buildPatch,
    type Draft,
    draftOf,
    FIELDS,
    GROUPS,
    groupIssues,
    isEmptyPatch,
    isRemoteUrl,
    issueReason,
    issuesOf,
    optionHint,
    optionLabel,
    timeZoneChoices,
  } from '../lib/settings.js'
  import type { AccountView, SettingsIssue, SettingsView } from '../lib/types.js'
  import Disclosure from './Disclosure.svelte'
  import Modal from './Modal.svelte'

  let {
    api,
    texts,
    account,
    onclose,
  }: { api: Api; texts: WebTexts; account: AccountView; onclose: () => void } = $props()

  const t = $derived(texts.ui.settings)
  // Only the id matters: `account` is a new object on every `accounts` event and the form must not be reloaded each time.
  const accountId = $derived(account.id)
  let loaded: SettingsView | null = $state.raw(null)
  let draft: Record<string, string | boolean> = $state({})
  let loadError: string | null = $state(null)
  let loadIssues: readonly SettingsIssue[] = $state.raw([])
  let issues: readonly SettingsIssue[] = $state.raw([])
  let failure: string | null = $state(null)
  let saved = $state(false)
  let saving = $state(false)
  const zones = timeZoneChoices()

  const grouped = $derived(groupIssues(issues))

  // RNF-02: choosing a provider that sends the text of the chats out of this machine asks for the agreement first. The
  // daemon answers 409 consentRequired; the change waits here until the box is ticked, then it is recorded and retried.
  let consent: { key: string; patch: Record<string, unknown>; agreed: boolean } | null = $state.raw(null)

  function show(view: SettingsView) {
    loaded = view
    draft = { ...draftOf(view) }
  }

  async function load(id: string) {
    try {
      show(await api.settings(id))
      loadError = null
    } catch (error) {
      const found = issuesOf(error)
      if (found !== null) loadIssues = found
      loadError = error instanceof ApiError ? error.code : 'internal'
    }
  }
  $effect(() => {
    const id = accountId
    untrack(() => load(id))
  })

  async function send(patch: Record<string, unknown>) {
    saving = true
    try {
      show(await api.saveSettings(accountId, patch))
      saved = true
      consent = null
    } catch (error) {
      const found = issuesOf(error)
      if (found !== null) issues = found
      else if (
        error instanceof ApiError &&
        error.code === 'consentRequired' &&
        error.provider !== undefined &&
        needsConsent(error.provider)
      ) {
        consent = { key: error.provider, patch, agreed: false }
      } else failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      saving = false
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (loaded === null) return
    failure = null
    saved = false
    issues = []
    consent = null
    const built = buildPatch(loaded, draft as Draft)
    if (!built.ok) {
      issues = [built.issue]
      return
    }
    if (isEmptyPatch(built.patch)) {
      failure = t.noChanges
      return
    }
    await send(built.patch)
  }

  async function agree() {
    if (consent === null || !consent.agreed) return
    const { key, patch } = consent
    saving = true
    failure = null
    try {
      // The consent is for what is disclosed: for an Ollama that is not on this machine, the address it is reached at.
      const typed = String(draft['provider.ollama.baseUrl'] ?? '').trim()
      const baseUrl = typed === '' ? loaded?.values.provider.ollama.baseUrl : typed
      await api.recordConsent(accountId, key, key === 'claude-cli' ? undefined : baseUrl)
    } catch (error) {
      failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
      saving = false
      return
    }
    saving = false
    await send(patch)
  }

  /** The host an Ollama that is not on this machine is reached at: the address typed, or the one in force. */
  function consentHost(): string | undefined {
    const typed = String(draft['provider.ollama.baseUrl'] ?? '').trim()
    return hostOf(typed === '' ? (loaded?.values.provider.ollama.baseUrl ?? '') : typed) ?? undefined
  }

  const sourceOf = (option: string): string | null => {
    const source = loaded?.sources[option]
    return source === undefined ? null : t.sources[source]
  }
  const label = (option: string): string => optionLabel(option, texts)
  const providerName = (name: string): string => (t.providerNames as Readonly<Record<string, string>>)[name] ?? name
</script>

<Modal title={fmt(t.title, { account: account.id })} closeLabel={texts.ui.close} {onclose}>
  {#if loadError !== null}
    <p class="note error" role="alert">{errorText(loadError, texts)}</p>
    {#if loadIssues.length > 0}
      <ul class="issues">
        {#each loadIssues as issue (`${issue.option}:${issue.code}`)}
          <li>{fmt(t.issue, { option: label(issue.option), reason: issueReason(issue, texts) })}</li>
        {/each}
      </ul>
    {/if}
  {:else if loaded === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <p class="muted">{t.appliesLive}</p>

    <form onsubmit={save}>
      {#each GROUPS as group (group)}
        <fieldset>
          <legend>{t.groups[group]}</legend>
          {#each FIELDS.filter((field) => field.group === group) as field (field.option)}
            {@const id = `setting-${field.option}`}
            {@const hint = optionHint(field.option, texts)}
            {@const problems = grouped.byOption[field.option] ?? []}
            <div class="field">
              {#if field.kind === 'boolean'}
                <label class="check">
                  <input type="checkbox" {id} bind:checked={draft[field.option] as boolean} aria-describedby="{id}-info" />
                  <span>{label(field.option)}</span>
                </label>
              {:else}
                <label for={id}>{label(field.option)}</label>
                {#if field.kind === 'language'}
                  <select {id} bind:value={draft[field.option] as string} aria-describedby="{id}-info">
                    {#each loaded.options.languages as language (language)}
                      <option value={language}>{t.languageNames[language]}</option>
                    {/each}
                  </select>
                {:else if field.kind === 'choice'}
                  <select {id} bind:value={draft[field.option] as string} aria-describedby="{id}-info">
                    <option value="">{t.none}</option>
                    {#each loaded.options.providers as provider (provider)}
                      <option value={provider}>{providerName(provider)}</option>
                    {/each}
                  </select>
                {:else if field.kind === 'number'}
                  <input type="number" {id} min="1" step="1" bind:value={draft[field.option] as string} aria-describedby="{id}-info" />
                {:else}
                  <input
                    type="text"
                    {id}
                    list={field.kind === 'timezone' ? 'setting-zones' : undefined}
                    autocomplete="off"
                    spellcheck="false"
                    bind:value={draft[field.option] as string}
                    aria-describedby="{id}-info"
                  />
                {/if}
              {/if}
              <p class="info muted" id="{id}-info">
                {#if hint !== undefined}{hint}{/if}
                {#if field.kind === 'text'}{t.emptyInherits}{/if}
                {#if sourceOf(field.option) !== null}<span class="source">({sourceOf(field.option)})</span>{/if}
              </p>
              {#if field.option === 'provider.ollama.baseUrl' && isRemoteUrl(String(draft[field.option] ?? '').trim() === '' ? loaded.values.provider.ollama.baseUrl : String(draft[field.option]))}
                <p class="note warn" role="status">{t.remoteOllama}</p>
              {/if}
              {#each problems as problem (problem.code)}
                <p class="problem" role="alert">{issueReason(problem, texts)}</p>
              {/each}
            </div>
          {/each}
        </fieldset>
      {/each}
      <datalist id="setting-zones">
        {#each zones as zone (zone)}
          <option value={zone}></option>
        {/each}
      </datalist>

      {#if grouped.general.length > 0}
        <div class="note error" role="alert">
          <p>{t.issuesHeading}</p>
          <ul class="issues">
            {#each grouped.general as issue (`${issue.option}:${issue.code}`)}
              <li>{fmt(t.issue, { option: label(issue.option), reason: issueReason(issue, texts) })}</li>
            {/each}
          </ul>
        </div>
      {:else if issues.length > 0}
        <p class="note error" role="alert">{t.issuesHeading}</p>
      {/if}
      {#if consent !== null}
        <div class="consent note warn" role="alert">
          <h3>{texts.ui.disclosure.consentTitle}</h3>
          <Disclosure {texts} provider={consent.key === 'claude-cli' ? 'claude-cli' : 'ollama'} host={consent.key === 'claude-cli' ? undefined : consentHost()} />
          <label class="check">
            <input
              type="checkbox"
              checked={consent.agreed}
              onchange={(event) => {
                if (consent !== null) consent = { ...consent, agreed: event.currentTarget.checked }
              }}
            />
            <span>{fmt(texts.ui.disclosure.consentCheckbox, { provider: consent.key === 'claude-cli' ? providerName('claude-cli') : (consentHost() ?? providerName('ollama')) })}</span>
          </label>
          <div>
            <button type="button" class="primary" disabled={saving || !consent.agreed} onclick={agree}>
              {saving ? texts.ui.disclosure.consentSaving : texts.ui.disclosure.consentAgree}
            </button>
          </div>
        </div>
      {/if}
      {#if failure !== null}
        <p class="note warn" role="alert">{failure}</p>
      {/if}
      {#if saved}
        <p class="note ok" role="status">{t.saved}</p>
      {/if}

      <div class="row-buttons">
        <button type="submit" class="primary" disabled={saving}>{saving ? t.saving : t.save}</button>
        <button type="button" onclick={onclose}>{texts.ui.close}</button>
      </div>
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
  }

  fieldset {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin: 0;
    padding: 0.75rem 0.9rem 0.9rem;
    display: grid;
    gap: 0.8rem;
  }

  legend {
    padding: 0 0.4rem;
    font-weight: 600;
  }

  .field {
    display: grid;
    gap: 0.25rem;
  }

  .field > label:not(.check) {
    font-weight: 600;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 600;
  }

  .info {
    font-size: 0.85rem;
  }

  .problem {
    color: var(--error);
    font-size: 0.9rem;
  }

  .issues {
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
  }

  .row-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .consent {
    display: grid;
    gap: 0.6rem;
  }

  .consent h3 {
    font-size: 1rem;
  }
</style>
