<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { isAccountIdValid } from '../lib/accounts.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'

  let {
    controller,
    texts,
    onadded,
  }: { controller: Controller; texts: WebTexts; onadded: (id: string) => void } = $props()

  const ui = $derived(texts.ui)
  let open = $state(false)
  let id = $state('')
  let code: string | null = $state(null)
  let sending = $state(false)

  // What is typed is checked as the daemon checks it; nothing is asked of the daemon until it is valid.
  const valid = $derived(isAccountIdValid(id))
  const shown = $derived(
    code !== null ? errorText(code, texts) : id !== '' && !valid ? texts.errors.invalidAccountId : null,
  )

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!valid || sending) return
    sending = true
    code = null
    const result = await controller.addAccount(id)
    sending = false
    if (!result.ok) {
      code = result.code
      return
    }
    const added = id
    id = ''
    open = false
    onadded(added)
  }

  function cancel() {
    open = false
    id = ''
    code = null
  }
</script>

{#if !open}
  <button type="button" class="primary" onclick={() => (open = true)}>{ui.addAccount.button}</button>
{:else}
  <form onsubmit={submit}>
    <label for="new-account-id">{ui.addAccount.idLabel}</label>
    <div class="line">
      <input
        id="new-account-id"
        type="text"
        bind:value={id}
        oninput={() => (code = null)}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        maxlength="32"
        aria-describedby="new-account-hint"
        aria-invalid={shown !== null}
      />
      <button type="submit" class="primary" disabled={!valid || sending}>{ui.addAccount.submit}</button>
      <button type="button" onclick={cancel}>{ui.cancel}</button>
    </div>
    <p id="new-account-hint" class="hint">{ui.addAccount.idHint}</p>
    {#if shown !== null}
      <p class="note error" role="alert">{shown}</p>
    {/if}
  </form>
{/if}

<style>
  form {
    display: grid;
    gap: 0.4rem;
    max-width: 34rem;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  input {
    flex: 1 1 10rem;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
