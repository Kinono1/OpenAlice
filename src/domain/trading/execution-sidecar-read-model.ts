import type { ExecutionCommandV1 } from './execution-protocol.js'

/** Read-only durable-admission projection used during restart reconciliation. */
export type ExecutionSidecarCommandAdmission =
  | { found: false }
  | {
      found: true
      /** Full canonical command proven against its typed wire projection. */
      command: ExecutionCommandV1
      commandId: string
      disposition: 'accepted' | 'duplicate'
      acceptedSequence: string
      /** Structurally validated and command-bound; signature trust remains with the admitting sidecar. */
      permitV2Id: string
      clientOrderId?: string
    }

export interface ExecutionSidecarReadModel {
  /**
   * Reads the authoritative sidecar ledger.  A missing command is not by
   * itself a terminal broker result and must never trigger an automatic retry.
   */
  getCommand(commandId: string): Promise<ExecutionSidecarCommandAdmission>
}
