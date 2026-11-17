import { backends } from '../support/persistence-backends.js'
import { describeCaptureRepositoryContract } from './capture-repository.contract.js'

for (const backend of backends) describeCaptureRepositoryContract(backend)
