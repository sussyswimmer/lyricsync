/** `v` held within [lo, hi]; lo wins if the range is empty. */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
