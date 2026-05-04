export interface LOBLevel {
  price: number;
  size: number;
}

export interface LOBSnapshot {
  bids: LOBLevel[];
  asks: LOBLevel[];
  timestamp: number;
}

export interface TradeTick {
  price: number;
  size: number;
  isBuy: boolean;
  timestamp: number;
}

export interface OFIResult {
  ofi: number;
  normalizedOfi: number;
  levelOfi: number[];
  timestamp: number;
}

export interface VPINResult {
  vpin: number;
  bucketsUsed: number;
  timestamp: number;
}

export interface ToxicFlowAlert {
  isAlert: boolean;
  severity: "none" | "warning" | "critical";
  ofi: number;
  vpin: number;
  reason: string;
  timestamp: number;
}
