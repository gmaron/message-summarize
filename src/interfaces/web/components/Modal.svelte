<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    title,
    closeLabel,
    onclose,
    children,
  }: { title: string; closeLabel: string; onclose: () => void; children: Snippet } = $props()

  let dialog: HTMLDialogElement | undefined = $state()
  $effect(() => {
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  })
</script>

<!-- A native dialog: it traps the focus, closes with Escape and says to assistive technology that it is modal. -->
<dialog bind:this={dialog} {onclose} aria-labelledby="modal-title">
  <header>
    <h2 id="modal-title">{title}</h2>
    <button type="button" onclick={() => dialog?.close()}>{closeLabel}</button>
  </header>
  <div class="body">{@render children()}</div>
</dialog>

<style>
  dialog {
    width: min(40rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    overflow: auto;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 0.5);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    font-size: 1.15rem;
  }

  .body {
    padding: 1rem;
    display: grid;
    gap: 0.9rem;
  }
</style>
