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

function moneyCents(value: number) {
  return Math.round(roundMoney(value) * 100);
}

function allocateCents(totalCents: number, weights: number[]) {
  const safeTotal = Math.max(0, Math.round(totalCents));
  const safeWeights = weights.map((weight) => finiteNonNegative(weight));
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (!safeWeights.length || safeTotal === 0 || weightTotal === 0) {
    return safeWeights.map(() => 0);
  }

  const rawShares = safeWeights.map((weight) => safeTotal * weight / weightTotal);
  const allocated = rawShares.map(Math.floor);
  let remainder = safeTotal - allocated.reduce((sum, value) => sum + value, 0);
  const priority = rawShares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
    allocated[priority[index % priority.length].index] += 1;
  }
  return allocated;
}

/**
 * Reconciled invoice lines after a document-level discount. Every monetary
 * column is allocated in halalas, so the line sums always match the header.
 */
export function calculateDocumentLineAmounts(input: FinancialInput) {
  const totals = calculateDocumentTotals(input);
  const vatRate = totals.vatPercent / 100;
  const sourceLines = input.lines || [];
  const rawNetWeights = sourceLines.map((line) => {
    const enteredTotal = finiteNonNegative(line.total);
    return line.vat_excluded === false && vatRate > 0
      ? enteredTotal / (1 + vatRate)
      : enteredTotal;
  });
  const netBeforeDiscount = allocateCents(moneyCents(totals.subtotal), rawNetWeights);
  const discounts = allocateCents(moneyCents(totals.discountAmount), netBeforeDiscount);
  const taxable = netBeforeDiscount.map((value, index) => Math.max(0, value - discounts[index]));
  const vat = allocateCents(moneyCents(totals.vatAmount), taxable);

  return {
    totals,
    lines: sourceLines.map((line, index) => {
      const enteredTotal = roundMoney(finiteNonNegative(line.total));
      const net = netBeforeDiscount[index] / 100;
      const discount = discounts[index] / 100;
      const taxableAmount = taxable[index] / 100;
      const vatAmount = vat[index] / 100;
      return {
        enteredTotal,
        netBeforeDiscount: net,
        discount,
        taxableAmount,
        vat: vatAmount,
        gross: roundMoney(taxableAmount + vatAmount),
      };
    }),
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
