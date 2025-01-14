import { ApiPromise } from '@polkadot/api'
import { ContractPromise } from '@polkadot/api-contract'
import { ContractCallOutcome, ContractOptions } from '@polkadot/api-contract/types'
import { EventRecord } from '@polkadot/types/interfaces'
import { Callback, IKeyringPair, ISubmittableResult } from '@polkadot/types/types'
import { BN, bnToBn, stringCamelCase } from '@polkadot/util'
import { decodeOutput } from './decodeOutput'
import { getAbiMessage } from './getAbiMessage'
import { getBalance } from './getBalance'
import { getMaxGasLimit } from './getGasLimit'

/**
 * Performs a dry run for the given contract method and arguments.
 * Is used within `contractQuery` & `contractTx` for gas estimation.
 */
export const contractCallDryRun = async (
  api: ApiPromise,
  account: IKeyringPair | string,
  contract: ContractPromise,
  method: string,
  options = {} as ContractOptions,
  args = [] as unknown[],
): Promise<ContractCallOutcome> => {
  const abiMessage = getAbiMessage(contract, method)
  const address = (account as IKeyringPair)?.address || account
  const { value, gasLimit, storageDepositLimit } = options
  const result = await api.call.contractsApi.call<ContractCallOutcome>(
    address,
    contract.address,
    value ?? new BN(0),
    gasLimit ?? null,
    storageDepositLimit ?? null,
    abiMessage.toU8a(args),
  )

  return result
}

/**
 * Calls a given non-mutating contract method (query) with maximum possible gas limit.
 */
export const contractQuery = async (
  api: ApiPromise,
  address: string,
  contract: ContractPromise,
  method: string,
  options = {} as ContractOptions,
  args = [] as unknown[],
): Promise<ContractCallOutcome> => {
  // HACK: This should be possible by setting the `gasLimit` to null or -1 in the future.
  const gasLimit = getMaxGasLimit(api)

  // Call actual query/tx
  const queryFn = contract.query[stringCamelCase(method)]
  return await queryFn(address, { ...options, gasLimit }, ...args)
}

/**
 * Calls a given mutating contract method (tx) and wraps it in a promise.
 * Before, a dry run is performed to determine the required gas & potential errors.
 */
export type ContractTxResult = {
  dryResult: ContractCallOutcome
  result?: ISubmittableResult
  errorMessage?: string | 'UserCancelled' | 'ExtrinsicFailed' | 'TokenBelowMinimum' | 'Error'
  errorEvent?: EventRecord
  successEvent?: EventRecord
  extrinsicHash?: string
  extrinsicIndex?: number
  blockHash?: string
}
export const contractTx = async (
  api: ApiPromise,
  account: IKeyringPair | string,
  contract: ContractPromise,
  method: string,
  options = {} as ContractOptions,
  args = [] as unknown[],
  statusCb?: Callback<ISubmittableResult>,
): Promise<ContractTxResult> => {
  // Check if account has sufficient balance
  const accountAddress = typeof account === 'string' ? account : account.address
  const { reducibleBalance } = await getBalance(api, accountAddress)
  const hasZeroBalance = !reducibleBalance || reducibleBalance.isZero()
  const hasBalanceBelowPassedValue =
    options?.value && reducibleBalance && reducibleBalance.lte(bnToBn(options.value))
  if (hasZeroBalance || hasBalanceBelowPassedValue) {
    return Promise.reject({
      errorMessage: 'TokenBelowMinimum',
    })
  }

  // Dry run to determine required gas and potential errors
  delete options.gasLimit
  const dryResult = await contractCallDryRun(api, account, contract, method, options, args)
  const { isError, decodedOutput } = decodeOutput(dryResult, contract, method)
  if (isError)
    return Promise.reject({
      dryResult,
      errorMessage: decodedOutput || 'Error',
    })

  // Call actual query/tx & wrap it in a promise
  const gasLimit = dryResult.gasRequired
  return new Promise(async (resolve, reject) => {
    try {
      const isDevelopment =
        (api.runtimeChain || '').toLowerCase() === 'development' ? 'isInBlock' : 'isFinalized'
      const finalStatus = isDevelopment ? 'isInBlock' : 'isFinalized'
      const asFinalStatus = isDevelopment ? 'asInBlock' : 'asFinalized'

      const tx = contract.tx[stringCamelCase(method)]({ ...options, gasLimit }, ...args)

      const unsub = await tx.signAndSend(account, async (result) => {
        statusCb?.(result)

        const isFinalized = result?.status?.[finalStatus]
        if (!isFinalized) return

        // Determine extrinsic and block info
        const extrinsicHash = result.txHash.toHex()
        const extrinsicIndex = result.txIndex
        const blockHash = result.status[asFinalStatus].toHex()

        const errorEvent = result?.events.find(({ event }) =>
          api.events.system.ExtrinsicFailed.is(event),
        )
        if (errorEvent) {
          // Reject if `ExtrinsicFailed` event was found
          reject({
            dryResult,
            errorMessage: decodeOutput || 'ExtrinsicFailed',
            errorEvent,
            extrinsicHash,
            extrinsicIndex,
            blockHash,
          })
          unsub?.()
        } else {
          // Resolve succesfully otherwise
          const successEvent = result?.events.find(({ event }) =>
            api.events.system.ExtrinsicSuccess.is(event),
          )

          resolve({
            dryResult,
            result,
            successEvent,
            extrinsicHash,
            extrinsicIndex,
            blockHash,
          })
          unsub?.()
        }
      })
    } catch (e: any) {
      let errorMessage = 'Error'

      if (e?.message?.match(/user reject request/i)) {
        errorMessage = 'UserCancelled'
      }

      const errorText = e?.toString?.()
      const rpcErrorCode =
        errorText && typeof errorText === 'string'
          ? errorText.match(/RpcError: (\d+):/i)?.[1]
          : null
      switch (rpcErrorCode) {
        case '1010':
          errorMessage = 'TokenBelowMinimum'
          break
        default:
          break
      }

      reject({ errorMessage })
    }
  })
}
