import { decodeFunctionData } from "viem";
import type { Hex } from "viem";

import { OCR2_AGGREGATOR_ABI, ACOA_AGGREGATOR_ABI } from "./abi.js";

export type OcrVariant = "ocr2" | "acoa";

export interface OcrDetectResult {
  variant: OcrVariant;
  // TODO: parsed fields such as report context, round id, answer, timestamp
}

export function detectOcrTransmit(input: Hex): OcrDetectResult | undefined {
  try {
    const decoded = decodeFunctionData({ abi: OCR2_AGGREGATOR_ABI, data: input });
    if (decoded.functionName === "transmit") return { variant: "ocr2" };
  } catch {}

  try {
    const decoded = decodeFunctionData({ abi: ACOA_AGGREGATOR_ABI, data: input });
    if (decoded.functionName === "transmit") return { variant: "acoa" };
  } catch {}

  return undefined;
}

export interface OcrPriceCandidate {
  // Raw answer as reported (scaled by decimals), if recoverable
  // For now left undefined until full report parsing is implemented.
  answer?: bigint;
}

export function tryDecodeOcrPriceFromInput(_variant: OcrVariant, _input: Hex): OcrPriceCandidate | undefined {
  // Placeholder for future OCR report parsing implementation.
  // The report bytes encode multiple fields including observations and median.
  // We will implement exact decoding per variant in subsequent iterations.
  return undefined;
}

