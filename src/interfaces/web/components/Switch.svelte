<script lang="ts">
  // A switch is a checkbox that looks like one. The label is written by the caller, around or beside it.
  let {
    checked,
    disabled = false,
    label,
    id,
    describedby,
    onchange,
  }: {
    checked: boolean
    disabled?: boolean
    /** The accessible name when no visible label is tied to it. */
    label?: string
    id?: string
    describedby?: string
    onchange: (checked: boolean) => void
  } = $props()
</script>

<span class="switch">
  <input
    type="checkbox"
    {id}
    {checked}
    {disabled}
    aria-label={label}
    aria-describedby={describedby}
    onchange={(event) => {
      const input = event.currentTarget
      onchange(input.checked)
      // The state decides how the switch looks: if it did not change (a request that is still going, a question
      // asked first), the switch goes back to what it was until it does.
      input.checked = checked
    }}
  />
  <span class="track"></span>
</span>

<style>
  .switch {
    position: relative;
    width: 40px;
    height: 24px;
    flex: none;
    display: inline-block;
  }

  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    margin: 0;
    cursor: pointer;
  }

  input:disabled {
    cursor: not-allowed;
  }

  .track {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: var(--line-strong);
    transition: background-color 0.15s ease-out;
    pointer-events: none;
  }

  .track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--knob);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
    transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  input:checked + .track {
    background: var(--ok);
  }

  input:checked + .track::after {
    transform: translateX(16px);
  }

  input:disabled + .track {
    opacity: 0.55;
  }

  input:focus-visible + .track {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
