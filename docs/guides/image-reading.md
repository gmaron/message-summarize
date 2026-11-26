# Reading images (optional)

It ships turned off. Unlike [audio transcription](transcription.md), **the picture leaves your machine**: read this before turning it on. Back to the [README](../../README.md).

## What it does

When it is on, an image that arrives while the daemon is connected (and those from the last `historyDays` days of the history WhatsApp sends when linking) is:

1. downloaded from WhatsApp's media host, through the same durable queue as audio (same checks on what the sender wrote, 10 MB at most, and counted in `transcription.maxMediaMb`);
2. read by a model with vision, through the **Claude Code CLI** you already use as provider (`provider.primary` must be `claude-cli`), run with no tools and in an empty directory, like the summarizer;
3. replaced, in the digest and in Ask, by what it says: `[image] caption (what the image says: «…»)`.

The picture is deleted as soon as it is read. What is kept is the text. A personal photo, a meme or a sticker has nothing to read: the model answers "nothing" and the image shows as `[image]`, as before.

## What leaves your machine

- **The image itself**, to Anthropic, through `claude`. With transcription the audio never leaves; here it does. That is why it is off by default and why `msum doctor` states it and warns when no consent is recorded for the provider (`msum provider use claude-cli` records it).
- **Conversations in `localOnlyPatterns` are never read.** It is checked twice: when the image is captured, and again right before it is read (so a chat you mark local-only later is protected too). An image of such a chat is dropped with the code `not-allowed`. The criterion is the same as for digests: the pattern matches `<id> <name>` of the conversation, and an unknown conversation is not read.
- Any other provider (an API key, Ollama, Gemini CLI, Codex) does **not** read images today: with them turned on, `doctor` warns and images stay as `[image]`.

## How to turn it on

Use `claude-cli` as the primary provider, then in `config.json` (or an account's own file):

```json
"imageReading": { "enabled": true, "historyDays": 7 }
```

Changing it restarts the account's unit. Nothing to install: only the `claude` you already have.

## Options

| Option | Default | What it means |
|---|---|---|
| `enabled` | `false` | Turns image reading on. |
| `historyDays` | `7` | Images of the history of the last N days are also read. `0` means no limit: the whole history (it can be thousands of images, each one a call to the model). |
| `timeoutMs` | `180000` | The most one image can take. |

Images share the queue and the slot of transcription: `transcription.concurrency` bounds how many things (audios and images) are processed at once, and the folder limit `transcription.maxMediaMb` applies to both. They do not need `transcription.enabled`: you can read images without transcribing audio, and the other way round.

## Limits

- Formats: JPEG, PNG and WebP (what WhatsApp sends for photos). Stickers, GIFs and videos are not read.
- Up to 2,000 characters of text are kept per image.
- An image that could not be read for good (corrupt, the model failed) is recorded as failed and not retried; if the CLI is missing or the connection is gone, it stays queued.
- The text comes from a picture somebody else sent: it is transcribed, never obeyed. The model has no tools, so an instruction written in a picture can do nothing but come back as text.
