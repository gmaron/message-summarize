<script lang="ts">
  import type { Snippet } from 'svelte'

  // A short question with two answers, in a native dialog: it traps the focus, closes with Escape and says to assistive
  // technology that it is modal. Closing it any way but "confirm" is a "cancel".
  let {
    title,
    confirmLabel,
    cancelLabel,
    tone = 'primary',
    busy = false,
    onconfirm,
    oncancel,
    children,
  }: {
    title: string
    confirmLabel: string
    cancelLabel: string
    tone?: 'primary' | 'danger'
    busy?: boolean
    onconfirm: () => void
    oncancel: () => void
    children: Snippet
  } = $props()

  let dialog: HTMLDialogElement | undefined = $state()
  let confirmed = false
  $effect(() => {
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  })

  const closed = () => {
    if (!confirmed) oncancel()
  }
  const confirm = () => {
    confirmed = true
    onconfirm()
  }
</script>

<dialog bind:this={dialog} onclose={closed} aria-labelledby="confirm-title">
  <h2 id="confirm-title">{title}</h2>
  <div class="text">{@render children()}</div>
  <div class="acts">
    <button type="button" class="btn" onclick={() => dialog?.close()}>{cancelLabel}</button>
    <button type="button" class="btn {tone === 'danger' ? 'primary danger-solid' : 'primary'}" disabled={busy} onclick={confirm}>
      {confirmLabel}
    </button>
  </div>
</dialog>

<style>
  dialog {
    border: 0;
    border-radius: 16px;
    padding: 24px;
    max-width: min(440px, calc(100vw - 32px));
    background: var(--surface);
    color: var(--ink);
    box-shadow: 0 20px 60px -20px rgb(0 0 0 / 0.4);
  }

  dialog::backdrop {
    background: rgb(21 27 33 / 0.45);
  }

  .text {
    margin-top: 8px;
    display: grid;
    gap: 8px;
    color: var(--ink-2);
    font-size: 0.9375rem;
  }

  .acts {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
    flex-wrap: wrap;
  }

  .danger-solid {
    background: var(--bad);
    border-color: var(--bad);
    color: var(--on-bad);
  }
</style>
