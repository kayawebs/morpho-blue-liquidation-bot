import type { Hex } from "viem";

import { detectOcrTransmit, tryDecodeOcrPriceFromInput } from "./decoder.js";

export async function tryDecodeOcrTransmitPrice(input: Hex): Promise<number | undefined> {
  const detected = detectOcrTransmit(input);
  if (!detected) return undefined;

  const candidate = tryDecodeOcrPriceFromInput(detected.variant, input);
  if (!candidate || candidate.answer === undefined) return undefined;

  // Note: scaling requires aggregator decimals; we will add it alongside
  // concrete parsing in a later iteration.
  return undefined;
}

