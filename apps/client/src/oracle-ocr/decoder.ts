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

// Parse OCR2 report bytes to extract observations array and compute median as answer.
// This matches OCR2 Aggregator behavior which derives the answer from observations (e.g., median).
export function tryDecodeOcr2AnswerFromInput(input: Hex): OcrPriceCandidate | undefined {
  try {
    const decoded = decodeFunctionData({ abi: OCR2_AGGREGATOR_ABI, data: input });
    if (decoded.functionName !== "transmit") return undefined;
    const [report] = decoded.args as [Hex, Hex[], Hex[], Hex];
    const observations = parseOcr2Observations(report);
    if (!observations || observations.length === 0) return undefined;
    const answer = median(observations);
    return { answer };
  } catch {
    return undefined;
  }
}

function median(values: bigint[]): bigint {
  const arr = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = arr.length;
  // Chainlink uses a deterministic median; for even n, choose lower-middle to avoid fractions.
  const idx = (n % 2 === 1) ? (n >> 1) : ((n >> 1) - 1);
  return arr[idx]!;
}

// Parse OCR2 report (bytes) to extract int192[] observations.
// The report is ABI-encoded; the observations dynamic array is referenced by a byte offset
// found at the 3rd 32-byte word of the report payload for typical OCR2 Aggregator builds.
function parseOcr2Observations(report: Hex): bigint[] | undefined {
  const bytes = hexToBytes(report);
  if (bytes.length < 96) return undefined;

  const word = (offset: number) => bytesToBigint(bytes.slice(offset, offset + 32));
  const obsOffset = Number(word(64)); // 3rd word (index 2) is offset to observations
  if (!Number.isFinite(obsOffset) || obsOffset + 32 > bytes.length) return undefined;

  const len = Number(word(obsOffset));
  if (!Number.isFinite(len) || len < 0) return undefined;
  const start = obsOffset + 32;
  const out: bigint[] = [];
  const needed = start + len * 32;
  if (needed > bytes.length) return undefined;
  for (let i = 0; i < len; i += 1) {
    const w = bytesToBigint(bytes.slice(start + i * 32, start + (i + 1) * 32));
    // Observations are int192 sign-extended to 256 bits; interpret as signed 256-bit then coerce to bigint.
    const signed = toSigned256(w);
    out.push(signed);
  }
  return out;
}

function hexToBytes(hex: Hex): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("invalid hex");
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function toSigned256(x: bigint): bigint {
  const TWO256 = 1n << 256n;
  const TWO255 = 1n << 255n;
  return x >= TWO255 ? x - TWO256 : x;
}
