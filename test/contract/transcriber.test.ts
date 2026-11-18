import { describe } from 'vitest'
import { WhisperCppTranscriber } from '../../src/infrastructure/transcription/index.js'
import { installFakeWhisper } from '../support/fake-whisper.js'
import { FakeTranscriber } from '../support/transcription-fakes.js'
import { describeTranscriberContract, type TranscriberBackend } from './transcriber.contract.js'

const fake: TranscriberBackend = {
  name: 'in-memory fake',
  make() {
    const files: Record<string, string> = {}
    return {
      transcriber: new FakeTranscriber(files),
      audio: (name, transcript) => {
        files[`/audio/${name}`] = transcript
        return `/audio/${name}`
      },
      missingAudio: '/audio/missing.ogg',
      dispose() {},
    }
  },
}

/** The real adapter, over a fake whisper-cli and a fake ffmpeg (shell scripts): no real whisper, ffmpeg or model. */
const whisperCpp: TranscriberBackend = {
  name: 'WhisperCppTranscriber',
  make() {
    const install = installFakeWhisper()
    return {
      transcriber: new WhisperCppTranscriber({
        whisperCommand: install.whisper,
        ffmpegCommand: install.ffmpeg,
        modelPath: install.model,
        tmpRoot: install.tmpRoot,
        timeoutMs: 20_000,
      }),
      audio: (name, transcript) => install.audio(name, transcript),
      missingAudio: `${install.dir}/audio/missing.ogg`,
      dispose: () => install.dispose(),
    }
  },
}

// The scripts are POSIX shell: Windows is not part of the v1 native matrix (RNF-05).
describe.skipIf(process.platform === 'win32')('Transcriber adapters', () => {
  describeTranscriberContract(fake)
  describeTranscriberContract(whisperCpp)
})
