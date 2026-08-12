import type { PaymentMethod } from '../workspace/types';

export type PaymentFeeRule = {
  method: PaymentMethod;
  label: string;
  feePercent: number;
  fixedFeeUsd: number;
  conversionSpreadPercent: number;
  note: string;
};

export const paymentFeeRules: PaymentFeeRule[] = [
  {
    method: 'none',
    label: 'Sem taxas',
    feePercent: 0,
    fixedFeeUsd: 0,
    conversionSpreadPercent: 0,
    note: 'O valor bruto e o líquido serão iguais.',
  },
  {
    method: 'paypal_international',
    label: 'PayPal internacional',
    feePercent: 6.4,
    fixedFeeUsd: 0.3,
    conversionSpreadPercent: 3.5,
    note: '4,79% + 1,61% internacional + US$ 0,30 e estimativa de 3,50% na conversão.',
  },
  {
    method: 'wise_ach',
    label: 'Wise · ACH',
    feePercent: 0,
    fixedFeeUsd: 0,
    conversionSpreadPercent: 0.78,
    note: 'Recebimento ACH gratuito e conversão estimada a partir de 0,78%.',
  },
  {
    method: 'wise_wire',
    label: 'Wise · Wire/Swift USD',
    feePercent: 0,
    fixedFeeUsd: 6.11,
    conversionSpreadPercent: 0.78,
    note: 'US$ 6,11 por recebimento e conversão estimada a partir de 0,78%.',
  },
  {
    method: 'custom',
    label: 'Personalizado',
    feePercent: 0,
    fixedFeeUsd: 0,
    conversionSpreadPercent: 0,
    note: 'Informe as taxas que aparecem no seu extrato.',
  },
];

export function paymentFeeRule(method: PaymentMethod) {
  return paymentFeeRules.find((rule) => rule.method === method) ?? paymentFeeRules[0];
}

export function estimateNetUsd(
  grossUsd: number,
  feePercent: number,
  fixedFeeUsd: number,
  conversionSpreadPercent: number,
) {
  if (!Number.isFinite(grossUsd) || grossUsd <= 0) return 0;
  const afterReceivingFee = grossUsd - grossUsd * feePercent / 100 - fixedFeeUsd;
  return roundCurrency(Math.max(0, afterReceivingFee * (1 - conversionSpreadPercent / 100)));
}

export function paymentMethodLabel(method: PaymentMethod) {
  return paymentFeeRule(method).label;
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
