import {
  AnthropicSummarizer,
  ClaudeCliSummarizer,
  GeminiSummarizer,
  GenericCliSummarizer,
  OllamaSummarizer,
  OpenAiCompatibleSummarizer,
} from '../../src/infrastructure/llm/index.js'
import { type FakeCli, installFakeCli } from '../support/fake-cli.js'
import { type FakeServer, startFakeServer } from '../support/fake-http-server.js'
import { isWindows } from '../support/platform.js'
import { type AnswererBackend, describeAnswererContract } from './answerer.contract.js'
import { NO_WAIT } from './summarizer.contract.js'

interface HttpSpec {
  readonly name: string
  readonly provider: string
  readonly local: boolean
  make(baseUrl: string, timeoutMs: number | undefined): ConstructorReturn
  body(text: string): string
}
type ConstructorReturn = import('../../src/application/ports/answerer.js').Answerer

const http = (spec: HttpSpec): AnswererBackend => ({
  name: spec.name,
  provider: spec.provider,
  local: spec.local,
  async open({ timeoutMs }) {
    const server: FakeServer = await startFakeServer()
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await server.close()
    }
    return {
      answerer: spec.make(server.baseUrl, timeoutMs),
      replyText: (text) => server.script({ body: spec.body(text) }),
      replyFailure: () => server.script({ status: 500, body: JSON.stringify({ error: { message: 'boom' } }) }),
      replyHang: () => server.script({ hang: true }),
      received: () => server.seen[0]?.raw ?? '',
      makeUnreachable: async () => {
        await close()
        return true
      },
      close,
    }
  },
})

const answerTimeout = (timeoutMs: number | undefined) => (timeoutMs === undefined ? {} : { answerTimeoutMs: timeoutMs })

const ollama = http({
  name: 'OllamaSummarizer',
  provider: 'ollama',
  local: true,
  make: (baseUrl, timeoutMs) => new OllamaSummarizer({ model: 'qwen3:4b', baseUrl, ...answerTimeout(timeoutMs) }),
  body: (text) => JSON.stringify({ message: { role: 'assistant', content: text } }),
})

const openai = http({
  name: 'OpenAiCompatibleSummarizer',
  provider: 'openai-compatible',
  local: false,
  make: (baseUrl, timeoutMs) =>
    new OpenAiCompatibleSummarizer({
      model: 'a-model',
      baseUrl: `${baseUrl}/v1`,
      retryClock: NO_WAIT,
      ...answerTimeout(timeoutMs),
    }),
  body: (text) =>
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }),
})

const anthropic = http({
  name: 'AnthropicSummarizer',
  provider: 'anthropic',
  local: false,
  make: (baseUrl, timeoutMs) =>
    new AnthropicSummarizer({
      model: 'a-model',
      baseUrl,
      apiKey: 'test-key-anthropic',
      retryClock: NO_WAIT,
      ...answerTimeout(timeoutMs),
    }),
  body: (text) =>
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
})

const gemini = http({
  name: 'GeminiSummarizer',
  provider: 'gemini',
  local: false,
  make: (baseUrl, timeoutMs) =>
    new GeminiSummarizer({
      model: 'a-model',
      baseUrl,
      apiKey: 'test-key-gemini',
      retryClock: NO_WAIT,
      ...answerTimeout(timeoutMs),
    }),
  body: (text) =>
    JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }),
})

/** A CLI is a fake executable that records its stdin and arguments. */
const cli = (
  name: string,
  provider: string,
  make: (path: string, timeoutMs: number | undefined) => ConstructorReturn,
  print: (text: string) => string,
): AnswererBackend => ({
  name,
  provider,
  local: false,
  async open({ timeoutMs }) {
    let fake: FakeCli = installFakeCli({ steps: [{ kind: 'text', text: '' }] })
    const built = () => make(fake.path, timeoutMs)
    let answerer = built()
    const reinstall = (step: Parameters<typeof installFakeCli>[0]) => {
      fake.dispose()
      fake = installFakeCli(step)
      answerer = built()
    }
    return {
      get answerer() {
        return answerer
      },
      replyText: (text) => reinstall({ steps: [{ kind: 'text', text: print(text) }] }),
      replyFailure: () => reinstall({ steps: [{ kind: 'text', text: '', code: 2, stderr: 'boom' }] }),
      replyHang: () => reinstall({ steps: [{ kind: 'hang' }] }),
      received: () => {
        const call = fake.calls('run')[0]
        return JSON.stringify(call?.argv.join('\n') ?? '') + JSON.stringify(call?.stdin ?? '')
      },
      makeUnreachable: async () => false,
      close: async () => fake.dispose(),
    } as import('./answerer.contract.js').AnswererFixture
  },
})

const claudeCli = cli(
  'ClaudeCliSummarizer',
  'claude-cli',
  (path, timeoutMs) =>
    new ClaudeCliSummarizer({ command: path, model: 'sonnet', killGraceMs: 100, ...answerTimeout(timeoutMs) }),
  (text) => JSON.stringify({ is_error: false, subtype: 'success', result: text }),
)

const genericCli = cli(
  'GenericCliSummarizer',
  'generic-cli',
  (path, timeoutMs) =>
    new GenericCliSummarizer({ command: [path], acknowledgeRisk: true, killGraceMs: 100, ...answerTimeout(timeoutMs) }),
  (text) => text,
)

for (const backend of [ollama, openai, anthropic, gemini]) describeAnswererContract(backend)
if (!isWindows) for (const backend of [claudeCli, genericCli]) describeAnswererContract(backend)
