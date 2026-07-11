export type DiscountMode = "fixed" | "percent";

export type FinancialLine = {
  total: number;
  vat_excluded?: boolean;
};

export type FinancialInput = {
  lines: FinancialLine[];
  discountValue?: number;
  discountMode?: DiscountMode;
  vatPercent?: number;
  additionalTax?: number;
};

export type Installment = {
  percent: number;
  label?: string;
  deadline_days?: number;
};

function finiteNonNegative(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeVatPercent(value: unknown, fallback = 15) {
  if (value === undefined || value === null || value === "") return fallback;
  return Math.min(100, finiteNonNegative(value, fallback));
}

export function calculateLineAmounts(line: FinancialLine, vatPercent = 15) {
  const rate = normalizeVatPercent(vatPercent) / 100;
  const enteredTotal = finiteNonNegative(line.total);
  const inclusive = line.vat_excluded === false;
  const net = inclusive && rate > 0 ? enteredTotal / (1 + rate) : enteredTotal;
  const gross = inclusive ? enteredTotal : enteredTotal * (1 + rate);
  return {
    enteredTotal: roundMoney(enteredTotal),
    net: roundMoney(net),
    vat: roundMoney(gross - net),
    gross: roundMoney(gross),
  };
}

export function calculateDocumentTotals(input: FinancialInput) {
  const vatPercent = normalizeVatPercent(input.vatPercent);
  const vatRate = vatPercent / 100;
  const discountMode: DiscountMode = input.discountMode === "percent" ? "percent" : "fixed";
  const discountValue = finiteNonNegative(input.discountValue);
  const subtotalRaw = (input.lines || []).reduce((sum, line) => {
    const total = finiteNonNegative(line.total);
    return sum + (line.vat_excluded === false && vatRate > 0 ? total / (1 + vatRate) : total);
  }, 0);
  const requestedDiscount = discountMode === "percent"
    ? subtotalRaw * Math.min(100, discountValue) / 100
    : discountValue;
  const discountAmountRaw = Math.min(subtotalRaw, requestedDiscount);
  const totalWithoutVatRaw = Math.max(0, subtotalRaw - discountAmountRaw);
  const vatAmountRaw = totalWithoutVatRaw * vatRate;
  const additionalTax = roundMoney(finiteNonNegative(input.additionalTax));

  return {
    subtotal: roundMoney(subtotalRaw),
    discountMode,
    discountValue: roundMoney(discountValue),
    discountAmount: roundMoney(discountAmountRaw),
    vatPercent,
    vatAmount: roundMoney(vatAmountRaw),
    totalWithoutVat: roundMoney(totalWithoutVatRaw),
    additionalTax,
    total: roundMoney(totalWithoutVatRaw + vatAmountRaw + additionalTax),
  };
}

export function validateInstallments(installments: Installment[]) {
  if (!Array.isArray(installments) || installments.length === 0 || installments.length > 6) {
    return { valid: false, totalPercent: 0, error: "Installments must contain between 1 and 6 entries." };
  }
  const totalPercent = roundMoney(installments.reduce((sum, item) => sum + finiteNonNegative(item.percent), 0));
  const hasInvalidPercent = installments.some((item) => {
    const percent = Number(item.percent);
    return !Number.isFinite(percent) || percent <= 0 || percent > 100;
  });
  if (hasInvalidPercent) return { valid: false, totalPercent, error: "Each installment must be between 0 and 100 percent." };
  if (totalPercent !== 100) return { valid: false, totalPercent, error: "Installment percentages must total 100." };
  return { valid: true, totalPercent, error: null };
}

export function calculateInstallmentAmounts(total: number, installments: Installment[]) {
  const validation = validateInstallments(installments);
  if (!validation.valid) throw new Error(validation.error || "Invalid installments.");
  const cleanTotal = roundMoney(finiteNonNegative(total));
  let allocated = 0;
  return installments.map((installment, index) => {
    const amount = index === installments.length - 1
      ? roundMoney(cleanTotal - allocated)
      : roundMoney(cleanTotal * Number(installment.percent) / 100);
    allocated = roundMoney(allocated + amount);
    return { ...installment, amount };
  });
}
