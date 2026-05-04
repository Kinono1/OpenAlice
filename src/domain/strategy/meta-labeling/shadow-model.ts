export interface ShadowTradeRecord {
  timestampMs: number
  features: Record<string, number>
  ruleBasedScore: number
  ruleBasedAdmitted: boolean
  tripleBarrierLabel?: 0 | 1
  realizedReturnPct?: number
}

export interface ShadowModelState {
  records: ShadowTradeRecord[]
  version: number
}

export class MetaLabelShadowModel {
  private records: ShadowTradeRecord[] = []
  private version = 0

  record(entry: ShadowTradeRecord): void {
    this.records.push(entry)
    if (this.records.length > 2000) {
      this.records = this.records.slice(-1000)
    }
  }

  labelOutcome(timestampMs: number, label: 0 | 1, returnPct: number): void {
    const rec = this.records.find((r) => r.timestampMs === timestampMs)
    if (rec) {
      rec.tripleBarrierLabel = label
      rec.realizedReturnPct = returnPct
    }
  }

  getLabeledCount(): number {
    return this.records.filter((r) => r.tripleBarrierLabel != null).length
  }

  isReadyForTraining(): boolean {
    return this.getLabeledCount() >= 300
  }

  exportState(): ShadowModelState {
    this.version += 1
    return { records: this.records.slice(), version: this.version }
  }

  importState(state: ShadowModelState): void {
    this.records = state.records.slice()
    this.version = state.version
  }

  getDiagnostics(): {
    totalRecords: number
    labeledRecords: number
    readyForTraining: boolean
    admissionRate: number
  } {
    const labeled = this.getLabeledCount()
    const admitted = this.records.filter((r) => r.ruleBasedAdmitted).length
    return {
      totalRecords: this.records.length,
      labeledRecords: labeled,
      readyForTraining: this.isReadyForTraining(),
      admissionRate: this.records.length > 0 ? admitted / this.records.length : 0,
    }
  }
}
