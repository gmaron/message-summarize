<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import ApiKeyField from '../components/ApiKeyField.svelte'
  import ModelPicker from '../components/ModelPicker.svelte'
  import Disclosure from '../components/Disclosure.svelte'
  import Icon from '../components/Icon.svelte'
  import Switch from '../components/Switch.svelte'
  import { isDigestRunning } from '../lib/accounts.js'
  import { API_PROVIDERS, consentAddress, displayHostOf, isApiProvider, openaiTarget, providerOfConsentKey } from '../lib/api-providers.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { differsFromOriginal } from '../lib/prompt.js'
  import { hrefOf } from '../lib/router.js'
  import {
    buildPatch,
    type Draft,
    shownDraft,
    storedDraft,
    draftOf,
    FIELDS,
    type FieldSpec,
    fieldsFor,
    inheritsWhenEmpty,
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
  import { MODEL_FIELDS } from '../lib/models.js'
  import { hostOf, needsConsent } from '../lib/setup.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, ModelProviderName, PromptView, SettingsIssue, SettingsView } from '../lib/types.js'

  // Ajustes: one row per option (what it is on the left, how to change it on the right) and a bar to save only when
  // something changed. The daemon checks every value; what it refuses is said next to the option.
  let {
    app,
    api,
    texts,
    account,
    ondirty,
  }: {
    app: AppState
    api: Api
    texts: WebTexts
    account: AccountView
    /** Tells the page whether there are changes that are not saved (leaving then asks first). */
    ondirty: (dirty: boolean) => void
  } = $props()

  const t = $derived(texts.ui.settings)
  // Only the id matters: `account` is a new object on every `accounts` event and the form must not be reloaded each time.
  const accountId = $derived(account.id)
  const running = $derived(isDigestRunning(app.digests[account.id]))
  let loaded: SettingsView | null = $state.raw(null)
  let draft: Record<string, string | boolean> = $state({})
  let loadError: string | null = $state(null)
  let loadIssues: readonly SettingsIssue[] = $state.raw([])
  let issues: readonly SettingsIssue[] = $state.raw([])
  let failure: string | null = $state(null)
  let saved = $state(false)
  let saving = $state(false)
  let prompt: PromptView | null = $state.raw(null)
  // Changes when a key is saved or removed: the lists of models are asked again.
  let keyVersion = $state(0)
  const zones = timeZoneChoices()

  const grouped = $derived(groupIssues(issues))
  const built = $derived.by(() => (loaded === null ? null : buildPatch(loaded, storedDraft(draft as Draft))))
  const dirty = $derived(built !== null && (!built.ok || !isEmptyPatch(built.patch)))

  // RNF-02: choosing a provider that sends the text of the chats out of this machine asks for the agreement first. The
  // daemon answers 409 consentRequired; the change waits here until the box is ticked, then it is recorded and retried.
  // `address`: the server the agreement is for, as it was on screen when the daemon asked (a remote Ollama, a compatible server):
  // the same address is what gets recorded, so the user never agrees to one host and sends to another.
  let consent: { key: string; patch: Record<string, unknown>; agreed: boolean; address?: string } | null = $state.raw(null)

  function show(view: SettingsView) {
    loaded = view
    draft = { ...shownDraft(view) }
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
    // Whether the prompt is the original one: a hint on the row of the prompt, nothing else depends on it.
    api
      .prompt(id)
      .then((view) => (prompt = view))
      .catch(() => (prompt = null))
  }
  $effect(() => {
    const id = accountId
    untrack(() => load(id))
  })

  // Closing the tab, or going to another page, with something typed asks first.
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
        // The daemon names the origin that would receive the text (the effective address after this change): that is what
        // the notice shows and what the agreement is recorded for.
        const address = consentAddress(error.provider, error.origin)
        consent = { key: error.provider, patch, agreed: false, ...(address === undefined ? {} : { address }) }
      } else failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      saving = false
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (loaded === null || built === null) return
    failure = null
    saved = false
    issues = []
    consent = null
    if (!built.ok) {
      issues = [built.issue]
      return
    }
    if (isEmptyPatch(built.patch)) return
    await send(built.patch)
  }

  function discard() {
    if (loaded !== null) draft = { ...shownDraft(loaded) }
    issues = []
    failure = null
    consent = null
  }

  async function agree() {
    if (consent === null || !consent.agreed) return
    const { key, patch, address } = consent
    saving = true
    failure = null
    try {
      // The consent is for what is disclosed: for a server of the user's choice, the address that was shown.
      await api.recordConsent(accountId, key, address)
    } catch (error) {
      failure = errorText(error instanceof ApiError ? error.code : 'internal', texts)
      saving = false
      return
    }
    saving = false
    await send(patch)
  }

  /** The address Ollama is reached at: the one typed, or the one in force. */
  const ollamaUrl = $derived.by(
    () => String(draft['provider.ollama.baseUrl'] ?? '').trim() || (loaded?.values.provider.ollama.baseUrl ?? ''),
  )
  /** The address Ollama is typed with in the form, or empty. */
  const ollamaTyped = $derived(String(draft['provider.ollama.baseUrl'] ?? '').trim())
  /** The field was emptied while the account has its own address: saving removes it, so the installation's one counts. */
  const ollamaCleared = $derived.by(
    () => ollamaTyped === '' && loaded?.sources['provider.ollama.baseUrl'] === 'account',
  )
  /** The host of an Ollama that is not on this machine (the text goes there), or undefined. */
  const ollamaHost = $derived(isRemoteUrl(ollamaUrl) ? (hostOf(ollamaUrl) ?? undefined) : undefined)
  /** The address OpenAI will have when the form is saved, as typed (empty: OpenAI's own, or what the installation gives). */
  const openaiTyped = $derived(String(draft['provider.openai.baseUrl'] ?? '').trim())
  /** The address OpenAI has now, saved: the key is for this one. */
  const openaiSaved = $derived.by(() => loaded?.values.provider.openai.baseUrl ?? '')
  /** Where `openai` goes once saved: an empty field may mean the installation's address, which is not visible here. */
  const openaiAim = $derived.by(() => openaiTarget(openaiTyped, openaiSaved, loaded?.sources['provider.openai.baseUrl']))
  const openaiCompatible = $derived(openaiAim.compatible)
  const openaiHost = $derived(openaiAim.address === null ? undefined : (displayHostOf(openaiAim.address) ?? undefined))
  const consentHost = (address: string | undefined): string | undefined =>
    address === undefined ? undefined : (displayHostOf(address) ?? undefined)

  const sourceOf = (option: string): string | null => {
    const source = loaded?.sources[option]
    return source === undefined ? null : t.sources[source]
  }
  const label = (option: string): string => optionLabel(option, texts)
  /** The models of OpenAI, Anthropic and Gemini: each sits under the key of its provider. */
  const isApiModel = (option: string): boolean => ['openai', 'anthropic', 'gemini'].includes(MODEL_FIELDS[option] ?? '')
  /** What describes a control: its hint, and the tag of where the value comes from when there is one. */
  const describedBy = (option: string, id: string): string => (sourceOf(option) === null ? `${id}-h` : `${id}-h ${id}-t`)
  const providerName = (name: string): string => (t.providerNames as Readonly<Record<string, string>>)[name] ?? name
  const unitOf: Readonly<Record<string, string>> = $derived({
    maxCharsPerConversation: t.units.chars,
    defaultWindowHours: t.units.hours,
    'provider.claudeCli.timeoutMs': t.units.seconds,
  })
  /** The hint under an option: what it does and that an empty text inherits (where the value comes from is a tag by the title). */
  const hintOf = (option: string, kind: string): string =>
    [optionHint(option, texts), kind === 'text' && inheritsWhenEmpty(option) ? t.emptyInherits : undefined].filter((part) => part !== undefined).join(' ')
  const providers = $derived(
    [String(draft['provider.primary'] ?? ''), String(draft['provider.backup'] ?? '')].filter(
      (name, index, all) => name !== '' && all.indexOf(name) === index,
    ),
  )
  /** One or two sentences on where the text of the chats goes with the provider that is chosen. */
  const privacyLine = $derived.by(() => {
    const primary = String(draft['provider.primary'] ?? '')
    if (primary === 'claude-cli') return t.privacySummary['claude-cli']
    if (primary === 'anthropic' || primary === 'gemini') return t.privacySummary[primary]
    if (primary === 'openai') {
      if (openaiAim.address === null) return t.privacySummary.openaiInherited
      return openaiCompatible
        ? fmt(t.privacySummary.openaiCompatible, { host: openaiHost ?? openaiAim.address })
        : t.privacySummary.openai
    }
    if (primary === 'ollama') {
      return ollamaHost === undefined ? t.privacySummary.ollama : fmt(t.privacySummary.ollamaRemote, { host: ollamaHost })
    }
    return t.privacySummary.none
  })
  const promptModified = $derived.by(() => prompt !== null && differsFromOriginal(prompt.text, prompt))
</script>

<!-- The row of a model: its title, its hint and the chooser (a list from the daemon: nobody types a model). -->
{#snippet modelRow(field: FieldSpec)}
  {@const id = `setting-${field.option}`}
  {@const problems = grouped.byOption[field.option] ?? []}
  <div class="set-row">
    <div class="txt">
      <span class="ttl"
        ><span id="{id}-label">{label(field.option)}</span>{#if sourceOf(field.option) !== null}<span class="tag" id="{id}-t"
            >{sourceOf(field.option)}</span
          >{/if}</span
      >
      <span class="hint" id="{id}-h">{hintOf(field.option, 'choice')}</span>
    </div>
    <div class="ctl">
      <ModelPicker
        {api}
        {texts}
        account={accountId}
        provider={MODEL_FIELDS[field.option] as ModelProviderName}
        {id}
        label={label(field.option)}
        bare
        labelledby="{id}-label"
        value={String(draft[field.option] ?? '')}
        onchange={(model) => (draft[field.option] = model)}
        describedby={describedBy(field.option, id)}
        baseUrl={field.option === 'provider.ollama.model' && ollamaTyped !== '' ? ollamaTyped : undefined}
        inherit={field.option === 'provider.ollama.model' && ollamaCleared}
        reload={keyVersion}
        typingOnly={field.option === 'provider.openai.model' && openaiTyped !== '' && openaiTyped !== openaiSaved}
      />
    </div>
    {#each problems as problem (problem.code)}
      <span class="problem" role="alert">{issueReason(problem, texts)}</span>
    {/each}
  </div>
{/snippet}

<div class="page-inner">
  <AccountHeader {account} {texts} tab="ajustes" {running} />

  {#if loadError !== null}
    <div class="notice bad" role="alert">
      <span>{errorText(loadError, texts)}</span>
      {#if loadIssues.length > 0}
        <ul>
          {#each loadIssues as issue (`${issue.option}:${issue.code}`)}
            <li>{fmt(t.issue, { option: label(issue.option), reason: issueReason(issue, texts) })}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if loaded === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <p class="small muted">{t.appliesLive}</p>
    <form class="stack" onsubmit={save}>
      {#each GROUPS as group (group)}
        <section class="form-section rows" aria-labelledby="group-{group}">
          <h2 id="group-{group}">{t.groups[group]}</h2>
          {#each fieldsFor(group, providers) as field (field.option)}
            {@const id = `setting-${field.option}`}
            {@const problems = grouped.byOption[field.option] ?? []}
            {#if field.kind === 'boolean'}
              <label class="set-row toggle" for={id}>
                <span class="txt">
                  <span class="ttl"><span>{label(field.option)}</span>{#if sourceOf(field.option) !== null}<span class="tag" id="{id}-t" aria-hidden="true">{sourceOf(field.option)}</span>{/if}</span>
                  <span class="hint" id="{id}-h">{hintOf(field.option, field.kind)}</span>
                </span>
                <span class="ctl end">
                  <Switch {id} describedby={describedBy(field.option, id)} checked={draft[field.option] === true} onchange={(on) => (draft[field.option] = on)} />
                </span>
                {#each problems as problem (problem.code)}
                  <span class="problem" role="alert">{issueReason(problem, texts)}</span>
                {/each}
              </label>
            {:else if MODEL_FIELDS[field.option] !== undefined}
              <!-- The model of an API provider sits under its key (see below); the others are here. -->
              {#if !isApiModel(field.option)}{@render modelRow(field)}{/if}
            {:else}
              <div class="set-row">
                <div class="txt">
                  <span class="ttl"><label for={id}>{label(field.option)}</label>{#if sourceOf(field.option) !== null}<span class="tag" id="{id}-t">{sourceOf(field.option)}</span>{/if}</span>
                  <span class="hint" id="{id}-h">{hintOf(field.option, field.kind)}</span>
                </div>
                <div class="ctl">
                  {#if field.kind === 'language'}
                    <select {id} aria-describedby={describedBy(field.option, id)} bind:value={draft[field.option] as string}>
                      {#each loaded.options.languages as language (language)}
                        <option value={language}>{t.languageNames[language]}</option>
                      {/each}
                    </select>
                  {:else if field.kind === 'choice'}
                    <select {id} aria-describedby={describedBy(field.option, id)} bind:value={draft[field.option] as string}>
                      <option value="">{t.none}</option>
                      {#each loaded.options.providers as provider (provider)}
                        <option value={provider}>{providerName(provider)}</option>
                      {/each}
                    </select>
                  {:else if field.kind === 'number'}
                    <span class="unit">
                      <input
                        type="text"
                        inputmode="numeric"
                        autocomplete="off"
                        {id}
                        aria-describedby={describedBy(field.option, id)}
                        aria-invalid={problems.length > 0}
                        bind:value={draft[field.option] as string}
                      />
                      <span class="suffix">{unitOf[field.option] ?? ''}</span>
                    </span>
                  {:else}
                    <input
                      type="text"
                      {id}
                      list={field.kind === 'timezone' ? 'setting-zones' : undefined}
                      autocomplete="off"
                      spellcheck="false"
                      aria-describedby={describedBy(field.option, id)}
                      aria-invalid={problems.length > 0}
                      bind:value={draft[field.option] as string}
                    />
                  {/if}
                  {#if field.option === 'provider.ollama.baseUrl' && ollamaHost !== undefined}
                    <span class="small bad-text" role="status">{t.remoteOllama}</span>
                  {/if}
                </div>
                {#each problems as problem (problem.code)}
                  <span class="problem" role="alert">{issueReason(problem, texts)}</span>
                {/each}
              </div>
            {/if}
          {/each}
          {#if group === 'provider'}
            <div class="privacy">
              <Icon name="lock" />
              <b>{t.privacyTitle}</b>
              <p>{privacyLine}</p>
              {#if providers.length > 0}
                <details class="detail">
                  <summary>{t.privacyDetail}</summary>
                  {#each providers as name (name)}
                    {#if name === 'claude-cli' || name === 'ollama' || isApiProvider(name)}
                      <div class="stack-sm">
                        {#if providers.length > 1}<span class="strong">{providerName(name)}</span>{/if}
                        {#if name === 'openai' && openaiAim.address === null}
                          <p class="muted small">{t.privacySummary.openaiInherited}</p>
                        {:else}
                          <Disclosure
                            {texts}
                            provider={name}
                            host={name === 'ollama' ? ollamaHost : name === 'openai' && openaiCompatible ? openaiHost : undefined}
                            compatible={name === 'openai' && openaiCompatible}
                          />
                        {/if}
                      </div>
                    {/if}
                  {/each}
                </details>
              {/if}
            </div>
            {#each API_PROVIDERS.filter((name) => providers.includes(name)) as name (name)}
              <div class="set-row">
                <div class="txt">
                  <span>{providerName(name)}</span>
                </div>
                <div class="ctl">
                  <ApiKeyField
                    {api}
                    {texts}
                    account={accountId}
                    provider={name}
                    baseUrl={name === 'openai' ? openaiSaved : ''}
                    idSuffix="settings-{name}"
                    onkeychange={() => (keyVersion += 1)}
                    lockedNote={name === 'openai' && openaiTyped !== openaiSaved
                      ? texts.ui.disclosure.keys.lockedAddress
                      : undefined}
                  />
                </div>
              </div>
              {#each FIELDS.filter((field) => field.option === `provider.${name}.model`) as field (field.option)}
                {@render modelRow(field)}
              {/each}
            {/each}
          {/if}
        </section>
      {/each}

      <datalist id="setting-zones">
        {#each zones as zone (zone)}
          <option value={zone}></option>
        {/each}
      </datalist>

      <section class="form-section rows" aria-labelledby="group-prompt">
        <h2 id="group-prompt">{t.promptGroup}</h2>
        <div class="set-row">
          <div class="txt">
            <span>{t.promptLabel}</span>
            {#if prompt !== null}<span class="hint">{promptModified ? t.promptModified : t.promptOriginal}</span>{/if}
          </div>
          <div class="ctl end">
            <a class="btn" href={hrefOf({ name: 'prompt', id: accountId })}>{t.promptEdit}</a>
          </div>
        </div>
      </section>

      {#if grouped.general.length > 0}
        <div class="notice bad" role="alert">
          <b>{t.issuesHeading}</b>
          <ul>
            {#each grouped.general as issue (`${issue.option}:${issue.code}`)}
              <li>{fmt(t.issue, { option: label(issue.option), reason: issueReason(issue, texts) })}</li>
            {/each}
          </ul>
        </div>
      {:else if issues.length > 0}
        <p class="notice bad" role="alert">{t.issuesHeading}</p>
      {/if}
      {#if consent !== null}
        <div class="notice warn" role="alert">
          <h3>{texts.ui.disclosure.consentTitle}</h3>
          <Disclosure
            {texts}
            provider={providerOfConsentKey(consent.key) ?? 'claude-cli'}
            host={consentHost(consent.address)}
            compatible={consent.key === 'openai-compatible'}
          />
          <label class="check">
            <input
              type="checkbox"
              checked={consent.agreed}
              onchange={(event) => {
                if (consent !== null) consent = { ...consent, agreed: event.currentTarget.checked }
              }}
            />
            <span>{fmt(texts.ui.disclosure.consentCheckbox, { provider: consentHost(consent.address) ?? providerName(providerOfConsentKey(consent.key) ?? 'claude-cli') })}</span>
          </label>
          <div class="acts">
            <button type="button" class="btn primary" disabled={saving || !consent.agreed} onclick={agree}>
              {saving ? texts.ui.disclosure.consentSaving : texts.ui.disclosure.consentAgree}
            </button>
          </div>
        </div>
      {/if}
      {#if failure !== null}
        <p class="notice warn" role="alert">{failure}</p>
      {/if}
      {#if saved && !dirty}
        <p class="notice ok" role="status">{t.saved}</p>
      {/if}

      {#if dirty}
        <div class="savebar">
          <span class="small muted msg">{t.unsaved}</span>
          <button type="button" class="btn" disabled={saving} onclick={discard}>{t.discard}</button>
          <button type="submit" class="btn primary" disabled={saving}>{saving ? t.saving : t.save}</button>
        </div>
      {/if}
    </form>
  {/if}
</div>
