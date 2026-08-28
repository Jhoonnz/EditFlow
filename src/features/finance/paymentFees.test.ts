import { describe, expect, it } from 'vitest';
import { estimateNetUsd } from './paymentFees';

describe('batch payment fees', () => {
  it('applies a fixed receiving fee only once to a batch', () => {
    const batchNet = estimateNetUsd(200, 0, 6, 0);
    const individuallyCalculated = estimateNetUsd(100, 0, 6, 0) * 2;

    expect(batchNet).toBe(194);
    expect(individuallyCalculated).toBe(188);
  });

  it('keeps BRL PIX payments fee free', () => {
    expect(estimateNetUsd(450, 0, 0, 0)).toBe(450);
  });
});
