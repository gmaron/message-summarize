<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { MAX_ASK_PRESETS } from '../../../domain/ask-presets.js'
  import { MAX_QUESTION_CHARS } from '../../../domain/ask-text.js'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import Icon from '../components/Icon.svelte'
  import { accountActions } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import { type Block, parseMarkdown } from '../lib/markdown.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, AskPreset, AskView } from '../lib/types.js'

  // Pedir: a free request over the chats of a period, typed or dictated, answered as ONE text that sees all the chats
  // together. The answers are private text: they come from the daemon on request, are drawn as text nodes only (never as
  // markup, see lib/markdown.ts) and are kept by the daemon in the account's database, not in this page.
  let { api, texts, account, now }: { app: AppState; api: Api; texts: WebTexts; account: AccountView; now: number } =
    $props()
  const t = $derived(texts.ui.ask)
  const id = $derived(account.id)
  const usable = $derived(accountActions(account).digest)

  type Period = AskView['period']
  type Selection = AskView['selection']
  const periods: readonly Period[] = ['today', 'h24', 'd3', 'd7']
  const selections: readonly Selection[] = ['unanswered', 'unread', 'all']

  let question = $state('')
  let period: Period = $state('today')
  let selection: Selection = $state('all')
  let touched = false
  let chats = $state('')
  let deliver = $state(true)
  let submitting = $state(false)
  let error: string | null = $state(null)
  let asks: readonly AskView[] = $state.raw([])
  let loaded = $state(false)
  let copied = $state(-1)
  let presets: readonly AskPreset[] = $state.raw([])
  let presetsAreDefaults = $state(true)
  let presetName = $state('')
  let savingPreset = $state(false)
  let presetNote: string | null = $state(null)

  const running = $derived(submitting || asks.some((a) => a.state === 'running'))
  const tooLong = $derived(question.length > MAX_QUESTION_CHARS)

  async function load(): Promise<void> {
    try {
      asks = await api.asks(untrack(() => id))
    } catch {
      // The list is an extra: the form keeps working.
    } finally {
      loaded = true
    }
  }

  // The account's own setting is where the selection starts: "unread only" reads the unread, otherwise everything.
  async function loadSelection(): Promise<void> {
    try {
      const settings = await api.settings(untrack(() => id))
      if (!touched) selection = settings.values.unreadOnly ? 'unread' : 'all'
    } catch {
      // The default stays.
    }
  }

  async function loadPresets(): Promise<void> {
    try {
      const found = await api.askPresets(untrack(() => id))
      presets = found.presets
      presetsAreDefaults = found.defaults
    } catch {
      // No presets: the form keeps working.
    }
  }

  // Loaded once, and followed every 2 seconds only while a request is running.
  $effect(() => {
    void id
    void load()
    void loadPresets()
    void loadSelection()
  })
  $effect(() => {
    if (!running) return
    const timer = setInterval(() => void load(), 2000)
    return () => clearInterval(timer)
  })

  async function submit(): Promise<void> {
    if (question.trim() === '' || running || tooLong) return
    error = null
    submitting = true
    try {
      await api.ask(id, {
        question,
        period,
        selection,
        deliver,
        chats: chats
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c !== ''),
      })
      question = ''
      await load()
    } catch (e) {
      error = errorText(e instanceof ApiError ? e.code : null, texts)
    } finally {
      submitting = false
    }
  }

  async function remove(askId: number): Promise<void> {
    try {
      await api.deleteAsk(id, askId)
    } catch {
      // already gone
    }
    await load()
  }

  // The answer as plain text for the clipboard: the markdown as the model wrote it.
  async function copy(ask: AskView): Promise<void> {
    try {
      await navigator.clipboard.writeText(ask.result?.answer ?? '')
      copied = ask.id
    } catch {
      copied = -1
    }
  }

  const statsOf = (ask: AskView): string => {
    const result = ask.result
    if (result === undefined) return ''
    const plural = (count: number, one: string, many: string): string => (count === 1 ? one : fmt(many, { count }))
    return fmt(t.stats, {
      chats: plural(result.chats, t.statsChatsOne, t.statsChatsMany),
      messages: plural(result.messages, t.statsMessagesOne, t.statsMessagesMany),
    })
  }
  const failedText = (ask: AskView): string => errorText(ask.error === 'failed' ? null : ask.error, texts)
  const progressText = (ask: AskView): string => {
    const progress = ask.progress
    if (progress === undefined) return t.running
    return progress.phase === 'writing' ? t.progressWriting : fmt(t.progressReading, progress)
  }
  const deliveryText = (ask: AskView): string | null =>
    ask.delivery === 'off' ? null : t.delivery[ask.delivery]
  const blocksOf = (ask: AskView): Block[] => parseMarkdown(ask.result?.answer ?? '')

  // Saved requests: one click puts the text in the box; the current text can be saved under a name.
  function usePreset(preset: AskPreset): void {
    question = preset.text
  }

  async function writePresets(next: readonly AskPreset[]): Promise<void> {
    savingPreset = true
    presetNote = null
    try {
      const saved = await api.saveAskPresets(id, next)
      presets = saved.presets
      presetsAreDefaults = saved.defaults
      return
    } catch (e) {
      presetNote = errorText(e instanceof ApiError ? e.code : null, texts)
    } finally {
      savingPreset = false
    }
  }

  async function savePreset(): Promise<void> {
    const name = presetName.trim()
    const text = question.trim()
    if (name === '' || text === '' || tooLong) return
    // The first own preset starts from the ones in view, so the defaults are not lost; one with the same name is replaced.
    const kept = presets.filter((p) => p.name !== name)
    if (kept.length >= MAX_ASK_PRESETS) {
      presetNote = t.presetsFull
      return
    }
    await writePresets([...kept, { name, text }])
    if (presetNote === null) {
      presetName = ''
      presetNote = t.presetSaved
    }
  }

  async function removePreset(name: string): Promise<void> {
    await writePresets(presets.filter((p) => p.name !== name))
  }

  // Dictation: the speech recognition of the browser, when it has one. It only fills the box: the user reads it first.
  type Recognition = {
    lang: string
    interimResults: boolean
    continuous: boolean
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
    onerror: ((event: { error: string }) => void) | null
    onend: (() => void) | null
    start(): void
    stop(): void
  }
  const Speech = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
  const SpeechApi = Speech.SpeechRecognition ?? Speech.webkitSpeechRecognition
  let listening = $state(false)
  let micNote: string | null = $state(null)
  let recognition: Recognition | null = null
  let base = ''

  function toggleMic(): void {
    if (SpeechApi === undefined) {
      micNote = t.micUnsupported
      return
    }
    if (listening) {
      recognition?.stop()
      return
    }
    micNote = null
    const r = new SpeechApi()
    r.lang = texts.locale
    r.interimResults = true
    r.continuous = false
    base = question.trim() === '' ? '' : `${question.trim()} `
    r.onresult = (event) => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) text += event.results[i]?.[0]?.transcript ?? ''
      question = base + text
    }
    r.onerror = (event) => {
      micNote = t.micUnsupported
    }
    r.onend = () => {
      listening = false
    }
    recognition = r
    listening = true
    try {
      r.start()
    } catch {
      listening = false
    }
  }
  onDestroy(() => recognition?.stop())
</script>

<div class="page-inner">
  <AccountHeader {account} {texts} tab="pedir" />

  <div class="stack">
    {#if !usable}<div class="notice warn measure" role="status">{t.notRunning}</div>{/if}

    <form class="panel stack measure" onsubmit={(e) => { e.preventDefault(); void submit() }}>
      <div class="field">
        <span class="lab" id="ask-presets">{t.presetsLabel}</span>
        <div class="chips" role="group" aria-labelledby="ask-presets">
          {#each presets as preset (preset.name)}
            <span class="cluster">
              <button type="button" class="chip" onclick={() => usePreset(preset)} disabled={!usable}>{preset.name}</button>
              {#if !presetsAreDefaults}
                <button type="button" class="btn sm quiet" aria-label={`${t.presetRemove}: ${preset.name}`} disabled={savingPreset} onclick={() => removePreset(preset.name)}>
                  <Icon name="trash" />
                </button>
              {/if}
            </span>
          {/each}
        </div>
        {#if presetsAreDefaults}<span class="hint">{t.presetsDefaultsNote}</span>{/if}
      </div>

      <div class="field">
        <label for="ask-q">{t.questionLabel}</label>
        <textarea id="ask-q" rows="5" maxlength={MAX_QUESTION_CHARS} placeholder={t.placeholder} bind:value={question} disabled={!usable}></textarea>
        <span class="hint">{fmt(t.questionCount, { count: question.length, max: MAX_QUESTION_CHARS })}</span>
        <div class="cluster">
          <button type="button" class="btn sm" aria-pressed={listening} onclick={toggleMic} disabled={!usable}>
            <Icon name="mic" />{t.mic}
          </button>
          {#if listening}<span class="small muted" role="status">{t.micListening}</span>{/if}
        </div>
        {#if micNote !== null}<span class="err" role="alert">{micNote}</span>{/if}
        <span class="hint">{t.micNote}</span>
      </div>

      <div class="field">
        <label for="ask-preset-name">{t.presetSaveTitle}</label>
        <div class="cluster">
          <input id="ask-preset-name" type="text" maxlength="60" placeholder={t.presetNamePlaceholder} bind:value={presetName} disabled={!usable} />
          <button type="button" class="btn sm" disabled={!usable || savingPreset || presetName.trim() === '' || question.trim() === '' || tooLong} onclick={savePreset}>
            {t.presetSave}
          </button>
        </div>
        {#if presetNote !== null}<span class="hint" role="status">{presetNote}</span>{/if}
      </div>

      <div class="field">
        <span class="lab" id="ask-selection">{t.selectionLabel}</span>
        <div class="chips" role="group" aria-labelledby="ask-selection">
          {#each selections as s (s)}
            <button type="button" class="chip" aria-pressed={selection === s} title={t.selections[s].hint} onclick={() => {
                touched = true
                selection = s
              }}>{t.selections[s].label}</button>
          {/each}
        </div>
        <span class="hint">{t.selections[selection].hint}</span>
      </div>

      <div class="field">
        <span class="lab" id="ask-period">{t.periodLabel}</span>
        <div class="chips" role="group" aria-labelledby="ask-period">
          {#each periods as p (p)}
            <button type="button" class="chip" aria-pressed={period === p} onclick={() => (period = p)}>{t.periods[p]}</button>
          {/each}
        </div>
      </div>

      <div class="field">
        <label for="ask-chats">{t.chatsLabel}</label>
        <input id="ask-chats" type="text" placeholder={t.chatsPlaceholder} bind:value={chats} disabled={!usable} />
      </div>

      <div class="field">
        <label class="check">
          <input type="checkbox" aria-describedby="ask-deliver-hint" bind:checked={deliver} disabled={!usable} />
          <span>{t.deliverLabel}</span>
          <span class="hint" id="ask-deliver-hint">{t.deliverHint}</span>
        </label>
      </div>

      {#if error !== null}<div class="notice bad" role="alert">{error}</div>{/if}
      <div class="cluster">
        <button type="submit" class="btn primary" disabled={!usable || running || question.trim() === '' || tooLong}>
          <Icon name="send" />{t.submit}
        </button>
      </div>
    </form>

    <div class="sr" role="status" aria-live="polite">{running ? t.running : ''}</div>

    <h2>{t.historyTitle}</h2>
    {#if loaded && asks.length === 0}<p class="muted measure">{t.historyEmpty}</p>{/if}
    {#each asks as ask (ask.id)}
      <article class="panel stack measure">
        <p class="break question"><strong>{ask.question}</strong></p>
        <p class="small muted">
          {t.selections[ask.selection].label}{texts.ui.text.separator}{t.periods[ask.period]}{texts.ui.text.separator}{formatDateTime(ask.createdAt, account.timezone, texts.locale)}
          {#if ask.chats.length > 0}{texts.ui.text.separator}{ask.chats.join(', ')}{/if}
        </p>
        {#if ask.state === 'running'}
          <div class="progress">
            {#if ask.progress !== undefined && ask.progress.phase === 'reading'}
              <progress class="bar" aria-label={progressText(ask)} max={ask.progress.total} value={ask.progress.done}></progress>
            {:else}
              <progress class="bar" aria-label={progressText(ask)}></progress>
            {/if}
          </div>
          <p class="small muted">{progressText(ask)}</p>
        {:else if ask.state === 'failed'}
          <div class="notice bad" role="alert">{failedText(ask)}</div>
        {:else if ask.result !== undefined}
          <p class="small muted">{statsOf(ask)}</p>
          {#if ask.result.leftOutLocalOnly > 0}
            <div class="notice" role="status">{fmt(t.leftOutLocalOnly, { count: ask.result.leftOutLocalOnly })}</div>
          {/if}
          <div class="answer stack-sm">
            {#each blocksOf(ask) as block, index (index)}
              {#if block.kind === 'heading'}
                <svelte:element this={block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'} class="break">
                  {#each block.inline as piece, i (i)}{#if piece.bold}<strong>{piece.text}</strong>{:else}{piece.text}{/if}{/each}
                </svelte:element>
              {:else if block.kind === 'list'}
                <svelte:element this={block.ordered ? 'ol' : 'ul'}>
                  {#each block.items as item, n (n)}
                    <li class="break">{#each item as piece, i (i)}{#if piece.bold}<strong>{piece.text}</strong>{:else}{piece.text}{/if}{/each}</li>
                  {/each}
                </svelte:element>
              {:else}
                <p class="break">{#each block.inline as piece, i (i)}{#if piece.bold}<strong>{piece.text}</strong>{:else}{piece.text}{/if}{/each}</p>
              {/if}
            {/each}
          </div>
          {#if deliveryText(ask) !== null}<p class="small muted" role="status">{deliveryText(ask)}</p>{/if}
        {/if}
        <div class="cluster">
          {#if ask.state === 'done' && ask.result !== undefined}
            <button type="button" class="btn sm" onclick={() => copy(ask)}>{copied === ask.id ? t.copied : t.copy}</button>
          {/if}
          {#if ask.state !== 'running'}
            <button type="button" class="btn sm quiet" onclick={() => remove(ask.id)}><Icon name="trash" />{t.remove}</button>
          {/if}
        </div>
      </article>
    {/each}
    <p class="small muted measure">{t.privateNote}</p>
  </div>
</div>

<style>
  .answer :global(p),
  .question {
    white-space: pre-wrap;
    margin: 0;
  }
</style>
