import {
  AnthropicSummarizer,
  GeminiSummarizer,
  OllamaSummarizer,
  OpenAiCompatibleSummarizer,
  type StructuredOutputMode,
} from '../../src/infrastructure/llm/index.js'
import { describeSummarizerContract, NO_WAIT, type SummarizerBackend } from './summarizer.contract.js'

const ollama: SummarizerBackend = {
  name: 'OllamaSummarizer',
  provider: 'ollama',
  make: (baseUrl, { timeoutMs }) =>
    new OllamaSummarizer({ model: 'qwen3:4b', baseUrl, ...(timeoutMs ? { timeoutMs } : {}) }),
  answer: (text) => JSON.stringify({ message: { role: 'assistant', content: text } }),
}

const openai = (structuredOutput: StructuredOutputMode): SummarizerBackend => ({
  name: `OpenAiCompatibleSummarizer (${structuredOutput})`,
  // A fake server on 127.0.0.1 is not OpenAI itself.
  provider: 'openai-compatible',
  make: (baseUrl, { timeoutMs }) =>
    new OpenAiCompatibleSummarizer({
      model: 'a-model',
      baseUrl: `${baseUrl}/v1`,
      structuredOutput,
      retryClock: NO_WAIT,
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
  answer: (text) =>
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }),
})

const anthropic: SummarizerBackend = {
  name: 'AnthropicSummarizer',
  provider: 'anthropic',
  make: (baseUrl, { timeoutMs }) =>
    new AnthropicSummarizer({
      model: 'a-model',
      baseUrl,
      apiKey: 'test-key-anthropic',
      retryClock: NO_WAIT,
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
  answer: (text) =>
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
}

const gemini: SummarizerBackend = {
  name: 'GeminiSummarizer',
  provider: 'gemini',
  make: (baseUrl, { timeoutMs }) =>
    new GeminiSummarizer({
      model: 'a-model',
      baseUrl,
      apiKey: 'test-key-gemini',
      retryClock: NO_WAIT,
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
  answer: (text) =>
    JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }),
}

for (const backend of [ollama, openai('json_schema'), openai('json_object'), openai('prompt'), anthropic, gemini]) {
  describeSummarizerContract(backend)
}
