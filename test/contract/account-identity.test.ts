import { accountBackends, describeAccountIdentityContract } from './account-identity.contract.js'

for (const backend of accountBackends) describeAccountIdentityContract(backend)
