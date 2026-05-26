"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend, ReferenceLine,
} from "recharts";

// =====================================================================
// Capital Allocation & Tax Model — Massachusetts edition
// Monthly time step internally; all user-facing time inputs use YEARS.
// =====================================================================

type Bracket = { upTo: number | null; rate: number };

const FED_BRACKETS_SINGLE_2025: Bracket[] = [
  { upTo: 11925, rate: 0.10 },
  { upTo: 48475, rate: 0.12 },
  { upTo: 103350, rate: 0.22 },
  { upTo: 197300, rate: 0.24 },
  { upTo: 250525, rate: 0.32 },
  { upTo: 626350, rate: 0.35 },
  { upTo: null, rate: 0.37 },
];

const FED_BRACKETS_MFJ_2025: Bracket[] = [
  { upTo: 23850, rate: 0.10 },
  { upTo: 96950, rate: 0.12 },
  { upTo: 206700, rate: 0.22 },
  { upTo: 394600, rate: 0.24 },
  { upTo: 501050, rate: 0.32 },
  { upTo: 751600, rate: 0.35 },
  { upTo: null, rate: 0.37 },
];

function applyBrackets(income: number, brackets: Bracket[]): number {
  if (income <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    const top = b.upTo ?? Infinity;
    if (income > top) {
      tax += (top - prev) * b.rate;
      prev = top;
    } else {
      tax += (income - prev) * b.rate;
      return tax;
    }
  }
  return tax;
}

const yearToMonth = (y: number) => Math.max(1, Math.round(y * 12));

// ---- Calendar-date helpers ----
function todayYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function parseYM(ym: string): { y: number; m: number } | null {
  if (!ym) return null;
  const [y, m] = ym.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  return { y, m };
}
// Decimal-year offset from planStart (0 = start month). Negative is allowed.
function ymToYearOffset(ym: string, start: string): number {
  const a = parseYM(ym); const b = parseYM(start);
  if (!a || !b) return 0;
  return ((a.y - b.y) * 12 + (a.m - b.m)) / 12;
}
function yearOffsetToYM(years: number, start: string): string {
  const b = parseYM(start);
  if (!b) return "";
  const total = b.y * 12 + (b.m - 1) + Math.round(years * 12);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
function relativeDescription(years: number): string {
  const total = Math.round(years * 12);
  if (total === 0) return "now";
  const abs = Math.abs(total);
  const y = Math.floor(abs / 12);
  const m = abs % 12;
  const dir = total < 0 ? "ago" : "from now";
  if (y === 0) return `${m}mo ${dir}`;
  if (m === 0) return `${y}y ${dir}`;
  return `${y}y ${m}mo ${dir}`;
}

// Cash needed in the house fund = house price × (down payment % + closing cost %).
function houseCashTarget(I: { houseTargetValue: number; houseDownPaymentPct: number; houseClosingCostPct: number }): number {
  return I.houseTargetValue * (I.houseDownPaymentPct + I.houseClosingCostPct);
}

// Monthly mortgage P&I — standard amortization. `mortgageRate` is the real
// annual rate (we model in real $); `principal` is the financed amount.
function mortgagePayment(I: {
  houseTargetValue: number; houseDownPaymentPct: number;
  mortgageRate: number; mortgageTermYears: number;
}): number {
  const principal = Math.max(0, I.houseTargetValue * (1 - I.houseDownPaymentPct));
  const n = Math.max(0, Math.round(I.mortgageTermYears * 12));
  if (principal <= 0 || n <= 0) return 0;
  const r = I.mortgageRate / 12;
  if (r <= 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

// Generic P&I given an arbitrary home value (used for the second home).
function mortgagePaymentFor(value: number, downPct: number, ratePerYear: number, termYears: number): number {
  const principal = Math.max(0, value * (1 - downPct));
  const n = Math.max(0, Math.round(termYears * 12));
  if (principal <= 0 || n <= 0) return 0;
  const r = ratePerYear / 12;
  if (r <= 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

// Remaining mortgage principal after `monthsElapsed` of standard amortization.
// Closed-form: B(t) = P × ((1+r)^N − (1+r)^t) / ((1+r)^N − 1).
function mortgageBalance(value: number, downPct: number, ratePerYear: number, termYears: number, monthsElapsed: number): number {
  const P = Math.max(0, value * (1 - downPct));
  const N = Math.max(0, Math.round(termYears * 12));
  const t = Math.max(0, Math.min(monthsElapsed, N));
  if (P <= 0 || N <= 0) return 0;
  const r = ratePerYear / 12;
  if (r <= 0) return P * (1 - t / N);
  return P * (Math.pow(1 + r, N) - Math.pow(1 + r, t)) / (Math.pow(1 + r, N) - 1);
}

// Recurring ownership costs beyond P&I — property tax + insurance +
// maintenance reserve + HOA. Treated as flat real $ (rates × home value).
// Uses ?? defaults so scenarios saved before these fields existed don't NaN.
function ownerCarryingMonthly(I: {
  houseTargetValue: number;
  propertyTaxRate?: number;
  homeInsuranceRate?: number;
  maintenanceRate?: number;
  hoaMonthly?: number;
}): number {
  const propRate = I.propertyTaxRate ?? DEFAULTS.propertyTaxRate;
  const insRate = I.homeInsuranceRate ?? DEFAULTS.homeInsuranceRate;
  const maintRate = I.maintenanceRate ?? DEFAULTS.maintenanceRate;
  const hoa = I.hoaMonthly ?? DEFAULTS.hoaMonthly;
  return (I.houseTargetValue * (propRate + insRate + maintRate)) / 12 + hoa;
}

// If `categoryOverrides` is populated, derived rent/inelastic/discretionary
// sums replace the lump fields. Otherwise the lumps are used as-is.
function effectiveExpenses(I: Inputs): { rent: number; inelastic: number; discretionary: number; medical: number } {
  if (!Array.isArray(I.categoryOverrides) || I.categoryOverrides.length === 0) {
    return {
      rent: I.rentMonthly,
      inelastic: I.inelasticMonthly,
      discretionary: I.discretionaryMonthly,
      medical: I.medicalMonthly,
    };
  }
  let rent = 0, inelastic = 0, discretionary = 0, medical = 0;
  for (const c of I.categoryOverrides) {
    if (c.bucket === "rent") rent += c.monthly;
    else if (c.bucket === "inelastic") inelastic += c.monthly;
    else if (c.bucket === "discretionary") discretionary += c.monthly;
    else if (c.bucket === "medical") medical += c.monthly;
  }
  return { rent, inelastic, discretionary, medical };
}

// ---- Stock awards ----
// Sum all of your unvested $ today (across however many grants) and pick a
// single representative schedule. The model spreads the total across the vest
// events and grows each portion at the real market rate to its vest date,
// with an optional haircut to discount stock-price downside.

// ---- Children (each triggers a 529 lump sum) ----
interface Child {
  id: string;
  name: string;
  birthYear: number;             // decimal year
  amount529: number;             // lump-sum at birth (mode="lump") OR per-month (mode="monthly")
  contribMode529?: "lump" | "monthly" | "auto"; // "auto" sizes monthly contrib to fully fund college
  contribUntilYears?: number;    // for "monthly": years from birth to keep contributing (default 18)
  collegeAnnualCost?: number;    // annual real $; 0 = none. Draws 529 then brokerage.
  collegeStartAge?: number;      // default 18
  collegeDurationYears?: number; // default 4
  monthlyCost?: number;          // real $/mo for this child while active
}

// ---- Life goals: scheduled withdrawals against projected balances ----
// `kind` controls which bucket is drawn first (then brokerage as fallback).
// One-time goals leave endYear undefined; recurring goals (kid expenses,
// college, retirement spend) set endYear and `amount` is an annual figure
// spread evenly across the months in the window.
type GoalKind = "home_purchase" | "kid_yearly" | "college" | "car" | "other";
interface Goal {
  id: string;
  kind: GoalKind;
  name: string;
  startYear: number;
  endYear?: number;
  amount: number;            // one-time total or annual amount (depending on endYear)
  autoRemainder?: boolean;   // if true, amount is auto-solved from leftover capacity (only one goal at a time)
  ownershipMonthly?: number; // ongoing recurring cost from startYear onward (e.g., car insurance + gas + maintenance)
}

interface GoalStatus {
  goalId: string;
  name: string;
  kind: GoalKind;
  scheduled: number;
  withdrawn: number;
  shortfall: number;
}

// Per-category expense override (replaces the lump rent/inelastic/discretionary/medical).
type ExpenseBucketTag = "rent" | "inelastic" | "discretionary" | "medical";
interface CategoryRow {
  category: string;
  monthly: number;
  bucket: ExpenseBucketTag;
}

interface Inputs {
  filingStatus: "single" | "mfj";  // initial filing status; flips to "mfj" at marriageYear if set
  planStartDate: string;          // YYYY-MM — always anchored to the current month on load
  horizonYears: number;           // computed at runtime as (100 − age); kept in schema for legacy
  userBirthYear: number;          // 4-digit calendar year; drives the run-to-age-100 horizon

  // Marriage — switches filing status to MFJ and adds spouse income from
  // that month onward. 0 = never (use the initial filingStatus throughout).
  marriageYear: number;
  spouseBaseAnnual: number;
  spouseBonusAnnual: number;
  spouseBonusMonth: number;
  spouseSalaryGrowth: number;     // real raise / yr; default 0.02

  // Cash compensation
  baseSalaryAnnual: number;
  bonusAnnual: number;
  bonusMonth: number;
  sideMonthlyCash: number;
  sideEndYear: number;       // 0 = none
  salaryGrowth: number;      // annual % increase applied to base/bonus/side

  // Stock — two pieces:
  //   (1) `rsuTotalValue` — remaining unvested bonus/refresh grants today,
  //       drawn down on a fixed vest schedule (one-time pool).
  //   (2) `annualStockBase` + `annualStockBonus` — recurring annual stock
  //       comp that vests each year, growing at the same real rate as base
  //       salary. Apply the haircut to both.
  rsuTotalValue: number;
  rsuFirstVestYear: number;
  rsuTotalVests: number;
  rsuVestsPerYear: number;
  annualStockBase: number;     // annual recurring base stock award (real $)
  annualStockBonus: number;    // annual recurring bonus stock award (real $)
  haircut: number;

  // 401k — all $ in today's purchasing power
  pct401k: number;             // employee contribution as a fraction of base salary
  max401kAlways: boolean;      // if true, contribute the annual IRS limit evenly across 12 months
  limit401k: number;           // IRS limit (in real $; assumed to grow with inflation)
  employerMatchRate: number;   // e.g. 0.5 = 50% of employee contribution

  // HSA — pre-tax for federal income tax AND FICA, but MA does NOT conform
  // (HSA contributions are still taxed at 5% by Massachusetts).
  hsaAnnual: number;           // employee HSA contribution per year (real $) — ignored when hsaAutoSize=true
  hsaLimit: number;            // IRS limit (real $)
  hsaEmployerAnnual: number;   // employer HSA contribution per year
  hsaAutoSize: boolean;        // if true, employee contrib = medical * 1.1 − employer (capped at limit)
  balHsaStart: number;

  // ESPP — assume sell-immediately strategy. Discount portion is taxable
  // ordinary income; the post-tax remainder flows into the brokerage via FCF.
  esppRate: number;            // % of base salary contributed
  esppDiscount: number;        // e.g. 0.15 = 15% discount
  esppAnnualCap: number;       // IRS §423 cap on purchase value (typically $25k)

  // Expenses (all in today's real $)
  //   housing is split out so we can swap rent → mortgage when a home_purchase
  //   goal fires. "inelastic" then covers everything else that's hard to cut
  //   (utilities, insurance, subscriptions, debt service).
  rentMonthly: number;
  // Mortgage P&I is auto-computed from house price, down %, term, and rate.
  mortgageRate: number;            // real annual rate, e.g. 0.045
  mortgageTermYears: number;       // e.g. 30
  // Other homeownership costs once you own (each is an annual % of houseTargetValue).
  propertyTaxRate: number;         // ≈ 0.012 for MA effective
  homeInsuranceRate: number;       // ≈ 0.004
  maintenanceRate: number;         // ≈ 0.01 ("1% rule")
  hoaMonthly: number;              // condo/HOA dues, $0 if SFH
  inelasticMonthly: number;
  inelasticGrowth: number;
  discretionaryMonthly: number;
  discretionaryGrowth: number;
  costPerKidMonthly: number;       // extra inelastic per active child
  kidYears: number;                // years a child counts as an active dependent
  medicalMonthly: number;          // qualified medical expenses paid from HSA (tax-free draw)
  medicalDropYear: number;         // decimal-year offset when medical drops to medicalAfterMonthly (0 = never)
  medicalAfterMonthly: number;     // medical/mo after medicalDropYear

  // Emergency fund — first priority in the waterfall.
  emergencyMonths: number;         // target months of expenses kept in cash
  balEmergencyStart: number;

  // Spouse share — scoped to home-after-buying (mortgage + property tax +
  // insurance + maintenance + HOA + down payment) plus kid costs (step-up,
  // 529 contributions, kid_yearly + college goals). Expressed as the % of
  // TOTAL cost the spouse pays. 0 = no spouse, 0.5 = even split.
  spouseSharePct: number;
  // Optional pre-buy roommate / cohabitation period — when set, spouse pays
  // `spouseRentSharePct` of the rent starting at `spouseMoveInYear`. Unrelated
  // to the post-buy home share above (renters often split rent at a different
  // ratio than they later split a mortgage).
  spouseMoveInYear: number;        // 0 = never moved in while renting
  spouseRentSharePct: number;      // 0..1 — % of rent spouse pays after move-in
  spouseCollegeSharePct: number;   // 0..1 — % of college tuition spouse pays (separate from general home + kids share)

  // Optional per-category override: when non-empty, the rent / inelastic /
  // discretionary lump fields above are overridden by the sums here.
  categoryOverrides: CategoryRow[];
  categoriesImportedYM: string;    // YYYY-MM of last successful import; "" = never

  // Allocation waterfall — house fund saves until cash needed for a target house value.
  houseTargetValue: number;        // target purchase price (first home)
  houseDownPaymentPct: number;     // e.g. 0.20 = 20% down
  houseClosingCostPct: number;     // e.g. 0.03 = 3% closing costs
  homePurchaseYear: number;        // decimal-year offset from plan start; 0 = no purchase

  // Optional second home — sell first, buy a new one. Real values assumed
  // flat (today's $). Sale of the first home pays off the remaining mortgage
  // and pays ~sellingClosingCostPct in commission + fees; net proceeds go
  // into the house fund, which then funds the next home's down payment.
  secondHomeYear: number;
  secondHomeValue: number;
  sellingClosingCostPct: number;
  // Additional home transitions (3rd, 4th, ...). Each entry triggers another
  // sell-current → buy-new event on its year. Processed in chronological order.
  additionalHomes: { id: string; year: number; value: number; name?: string }[];

  children: Child[];

  // Retirement
  retirementYear: number;                // 0 = never retire (pure projection)
  retirementExpenseMode: "snapshot" | "manual";
  retirementAnnualSpend: number;         // used only when mode === "manual"

  // Other life goals
  goals: Goal[];

  // Real returns (today's purchasing power)
  rNomAnnual: number;
  rSafeAnnual: number;

  // Informational only: used to label final balances as a nominal equivalent.
  inflationDisplay: number;

  // Withdrawal taxes
  capGainsTaxRate: number;             // brokerage LTCG: 15% fed + 5% MA ≈ 0.20
  retirementWithdrawTaxRate: number;   // ordinary income on 401k withdrawals in retirement (~25%)
  earlyWithdrawPenalty: number;        // 10% penalty if 401k withdrawn pre-retirement (=pre-59½)

  // Starting balances
  bal401kStart: number;
  balHouseStart: number;
  bal529Start: number;
  balBrokerageStart: number;

  // Tax constants
  ssWageCap: number;
  medicareSurtaxThreshold: number;       // single
  medicareSurtaxThresholdMFJ: number;    // MFJ
  // Child Tax Credit — $2,000/child under 17. Phases out $50 per $1,000 of
  // AGI above threshold ($200k single / $400k MFJ).
  ctcPerChild: number;
  ctcPhaseoutSingle: number;
  ctcPhaseoutMFJ: number;
  ctcChildMaxAge: number;
  fedStdDeductionSingle: number;
  fedStdDeductionMFJ: number;
  maPersonalExemptionSingle: number;
  maPersonalExemptionMFJ: number;
  maRate: number;
  maSurtaxRate: number;
  maSurtaxThreshold: number;
}

const DEFAULTS: Inputs = {
  filingStatus: "single",
  planStartDate: todayYM(),
  horizonYears: 70,        // computed at runtime as 100 - age; placeholder for new scenarios
  userBirthYear: 1996,

  marriageYear: 0,
  spouseBaseAnnual: 0,
  spouseBonusAnnual: 0,
  spouseBonusMonth: 2,
  spouseSalaryGrowth: 0.02,

  baseSalaryAnnual: 200000,
  bonusAnnual: 30000,
  bonusMonth: 2,
  sideMonthlyCash: 0,
  sideEndYear: 0,
  salaryGrowth: 0.02,      // ~2%/yr real raise above inflation (career-average)

  rsuTotalValue: 320000,
  rsuFirstVestYear: 0.25,
  rsuTotalVests: 16,
  rsuVestsPerYear: 4,
  annualStockBase: 0,
  annualStockBonus: 0,
  haircut: 0.15,

  pct401k: 0.10,           // 10% of base salary (ignored when max401kAlways=true)
  max401kAlways: true,     // default to maxing — it's almost always optimal
  limit401k: 23500,
  employerMatchRate: 0.5,

  hsaAnnual: 4300,
  hsaLimit: 4300,
  hsaEmployerAnnual: 1000,  // typical Microsoft / large-employer HSA seed
  hsaAutoSize: true,
  balHsaStart: 0,

  esppRate: 0.10,
  esppDiscount: 0.15,
  esppAnnualCap: 25000,

  rentMonthly: 3000,
  mortgageRate: 0.045,        // real annual; ≈ 7% nominal − 2.5% inflation
  mortgageTermYears: 30,
  propertyTaxRate: 0.012,     // MA average effective
  homeInsuranceRate: 0.004,
  maintenanceRate: 0.01,      // 1% rule
  hoaMonthly: 0,
  inelasticMonthly: 1500,     // everything inelastic EXCEPT housing
  inelasticGrowth: 0,
  discretionaryMonthly: 2500,
  discretionaryGrowth: 0,
  costPerKidMonthly: 1000,
  kidYears: 18,
  medicalMonthly: 0,
  medicalDropYear: 0,
  medicalAfterMonthly: 0,

  emergencyMonths: 6,
  balEmergencyStart: 10000,
  spouseSharePct: 0,
  spouseMoveInYear: 0,
  spouseRentSharePct: 0,
  spouseCollegeSharePct: 0.5,
  categoryOverrides: [],
  categoriesImportedYM: "",

  houseTargetValue: 900000,
  houseDownPaymentPct: 0.20,
  houseClosingCostPct: 0.03,
  homePurchaseYear: 0,
  secondHomeYear: 0,
  secondHomeValue: 0,
  sellingClosingCostPct: 0.07,
  additionalHomes: [],
  children: [],

  retirementYear: 30,
  retirementExpenseMode: "snapshot",
  retirementAnnualSpend: 80000,
  goals: [],

  rNomAnnual: 0.045,         // real market return (≈ 7% nominal − 2.5% inflation)
  rSafeAnnual: 0.01,         // real safe return
  inflationDisplay: 0.025,   // informational only
  capGainsTaxRate: 0.20,             // 15% fed LTCG + 5% MA
  retirementWithdrawTaxRate: 0.25,   // effective ordinary income in retirement
  earlyWithdrawPenalty: 0.10,        // pre-59½ on 401k

  bal401kStart: 80000,
  balHouseStart: 30000,
  bal529Start: 0,
  balBrokerageStart: 50000,

  ssWageCap: 176100,
  medicareSurtaxThreshold: 200000,
  medicareSurtaxThresholdMFJ: 250000,
  ctcPerChild: 2000,
  ctcPhaseoutSingle: 200000,
  ctcPhaseoutMFJ: 400000,
  ctcChildMaxAge: 17,
  fedStdDeductionSingle: 15000,
  fedStdDeductionMFJ: 30000,
  maPersonalExemptionSingle: 4400,
  maPersonalExemptionMFJ: 8800,
  maRate: 0.05,
  maSurtaxRate: 0.04,
  maSurtaxThreshold: 1_000_000,
};

interface MonthRow {
  t: number;
  year: number;
  monthOfYear: number;

  iBase: number;
  iBonus: number;
  iSide: number;
  iRSU: number;
  iGross: number;

  pmt401k: number;        // employee contribution
  empMatch: number;       // employer match (non-taxable, added to balance)
  pmtHsa: number;         // employee HSA contribution
  hsaEmp: number;         // employer HSA contribution
  esppDiscountIncome: number; // taxable ordinary income from ESPP discount

  taxFICA: number;
  iTaxable: number;
  taxFed: number;
  taxState: number;
  taxProperty: number;
  taxCapGains: number;
  taxTotal: number;

  iNet: number;
  fcf: number;

  pmtHouse: number;
  pmt529: number;
  pmtBrokerage: number;

  // Expense breakdown (for the annual summary).
  housingPaid: number;
  inelasticPaid: number;
  discretionaryPaid: number;
  kidCostPaid: number;
  collegePaid: number;
  medicalFromHsa: number;     // qualified medical paid out of HSA (silent NW reduction)
  investmentGrowth: number;   // compounding gain across all market buckets this month
  goalOwnershipByGoal: { goalId: string; amount: number }[]; // ongoing expense paid per goal this month
  expensesTotal: number;
  goalWithdrawals: number;
  goalEvents: { name: string; source?: string; amount: number }[];

  bal401k: number;
  balHsa: number;
  balEmergency: number;
  pmtEmergency: number;
  balHouse: number;
  bal529: number;
  balBrokerage: number;
  netWorth: number;
}

// Today's $ value vesting at month t, given the aggregate RSU schedule.
function rsuVestValueToday(I: Inputs, t: number): number {
  if (I.rsuTotalVests <= 0 || I.rsuVestsPerYear <= 0) return 0;
  const cadence = 12 / I.rsuVestsPerYear;
  if (!Number.isFinite(cadence) || cadence <= 0) return 0;
  const firstMonth = yearToMonth(I.rsuFirstVestYear);
  if (t < firstMonth) return 0;
  const lastMonth = firstMonth + Math.round((I.rsuTotalVests - 1) * cadence);
  if (t > lastMonth) return 0;
  const k = (t - firstMonth) / cadence;
  if (Math.abs(k - Math.round(k)) > 1e-6) return 0;
  return I.rsuTotalValue / I.rsuTotalVests;
}

interface SimResult {
  rows: MonthRow[];
  goals: GoalStatus[];
  retirementMonth: number;        // 0 = never retire
  brokerageDepleteYear: number | null; // year at which post-retirement brokerage hits 0
  // Year at which the brokerage went negative for the first time — i.e. when
  // we first had to dip into the emergency-fund cascade. Softer threshold
  // than full depletion: hitting this means non-investable funds are being
  // touched, but the plan might still survive.
  cascadeYear: number | null;
}

function simulate(I: Inputs): SimResult {
  const rows: MonthRow[] = [];
  const retirementMonth = I.retirementYear > 0 ? yearToMonth(I.retirementYear) : 0;

  // Pre-compute per-month scheduled withdrawals. autoRemainder goals are
  // resolved at runtime — their `perMonth` is left at 0 and we compute the
  // actual draw from whatever balance is available at the moment.
  // Synthesize implicit "college" goals for any child with collegeAnnualCost.
  // Treated identically to a user-added recurring college goal: draws from
  // that child's share of the 529 first, then brokerage.
  const synthesizedGoals: Goal[] = [];
  for (const c of I.children) {
    if (c.birthYear <= 0) continue;
    const cost = c.collegeAnnualCost ?? 0;
    if (cost <= 0) continue;
    const startAge = c.collegeStartAge ?? 18;
    const dur = c.collegeDurationYears ?? 4;
    if (dur <= 0) continue;
    // Align college to plan-year boundaries so a 4-year duration always
    // shows up in exactly 4 calendar rows of the table (no first-year
    // partial). Anchor on the plan year that contains the child's birth,
    // then span [birthYear + startAge, birthYear + startAge + dur) in plan
    // years. Convert to month-1 / month-12-of-end-year, then back to
    // decimal years so the existing goalSchedule path picks it up.
    const birthMonth = yearToMonth(c.birthYear);
    const birthPlanYear = Math.max(1, Math.ceil(birthMonth / 12));
    const collegeStartM = (birthPlanYear - 1 + startAge) * 12 + 1;
    const collegeEndM = collegeStartM + dur * 12 - 1;
    synthesizedGoals.push({
      id: `child-${c.id}-college`,
      kind: "college",
      name: `${c.name} college`,
      startYear: collegeStartM / 12,
      endYear: collegeEndM / 12,
      amount: cost,
    });
  }
  const allGoals: Goal[] = [...I.goals, ...synthesizedGoals];

  const goalSchedule = new Map<string, { startM: number; endM: number; perMonth: number; total: number; goal: Goal }>();
  for (const g of allGoals) {
    if (g.startYear <= 0) continue;
    if (!g.autoRemainder && g.amount <= 0) continue;
    const startM = yearToMonth(g.startYear);
    if (g.endYear && g.endYear > g.startYear) {
      const endM = yearToMonth(g.endYear);
      const months = Math.max(1, endM - startM + 1);
      const perMonth = g.autoRemainder ? 0 : g.amount / 12;
      goalSchedule.set(g.id, { startM, endM, perMonth, total: g.amount * (months / 12), goal: g });
    } else {
      const perMonth = g.autoRemainder ? 0 : g.amount;
      goalSchedule.set(g.id, { startM, endM: startM, perMonth, total: g.amount, goal: g });
    }
  }
  const goalStatuses = new Map<string, GoalStatus>(
    allGoals.map((g) => [g.id, { goalId: g.id, name: g.name, kind: g.kind, scheduled: 0, withdrawn: 0, shortfall: 0 }])
  );

  const rNomM = Math.pow(1 + I.rNomAnnual, 1 / 12) - 1;
  const rSafeM = Math.pow(1 + I.rSafeAnnual, 1 / 12) - 1;
  // Marriage flips filing status mid-projection. Resolved per month inside the
  // loop so brackets / std deduction / exemption update at the right time.
  const marriageMonth = (I.marriageYear ?? 0) > 0 ? yearToMonth(I.marriageYear) : 0;

  const months = Math.max(1, Math.round(I.horizonYears * 12));
  const sideEndMonth = I.sideEndYear > 0 ? yearToMonth(I.sideEndYear) : 0;

  // Lump-sum births: month → child. (For monthly-contrib children, the per-month
  // amount is computed inline in the waterfall.)
  const childLumpAtBirth = new Map<number, Child>();
  for (const c of I.children) {
    if (c.birthYear <= 0) continue;
    if ((c.contribMode529 ?? "lump") === "lump") {
      childLumpAtBirth.set(yearToMonth(c.birthYear), c);
    }
  }

  // YTD accumulators
  let ytdGross = 0;
  let ytdTaxable = 0;
  let ytd401k = 0;
  let ytdHsa = 0;
  let ytdEspp = 0;       // YTD ESPP purchase value
  let ytdSS = 0;

  let bal401k = I.bal401kStart;
  let balHsa = I.balHsaStart;
  let balEmergency = I.balEmergencyStart;
  let balHouse = I.balHouseStart;
  let bal529 = I.bal529Start;
  let balBrokerage = I.balBrokerageStart;

  // Home purchase month (if any) — drives the rent→mortgage transition AND
  // triggers a one-time withdrawal of the house cash target from house fund +
  // brokerage.
  const firstHomePurchaseMonth = I.homePurchaseYear > 0 ? yearToMonth(I.homePurchaseYear) : 0;

  // Unified list of all home transitions (purchase or upgrade), sorted by
  // month. The first one is the rent→own transition; each subsequent one
  // sells the previous home and buys the new one. Used by the "current home
  // value" lookup AND the sale+purchase event handlers below.
  type HomeTransition = { month: number; value: number; isFirst: boolean };
  const homeTransitions: HomeTransition[] = [];
  if (firstHomePurchaseMonth > 0 && (I.houseTargetValue ?? 0) > 0) {
    homeTransitions.push({ month: firstHomePurchaseMonth, value: I.houseTargetValue, isFirst: true });
  }
  if ((I.secondHomeYear ?? 0) > 0 && (I.secondHomeValue ?? 0) > 0 && firstHomePurchaseMonth > 0) {
    homeTransitions.push({ month: yearToMonth(I.secondHomeYear), value: I.secondHomeValue, isFirst: false });
  }
  for (const h of (I.additionalHomes ?? [])) {
    if (h.year > 0 && h.value > 0 && firstHomePurchaseMonth > 0) {
      homeTransitions.push({ month: yearToMonth(h.year), value: h.value, isFirst: false });
    }
  }
  homeTransitions.sort((a, b) => a.month - b.month);
  // After sorting, only the earliest can be "first". Re-mark.
  homeTransitions.forEach((h, i) => { h.isFirst = i === 0; });

  // Returns the home value owned at month t (0 if not housed yet).
  const homeValueAt = (t: number): number => {
    let v = 0;
    for (const h of homeTransitions) {
      if (t >= h.month) v = h.value;
      else break;
    }
    return v;
  };
  // Returns the most recent transition month at or before t (when the current
  // home was purchased). 0 = not housed yet.
  const lastTransitionMonthAt = (t: number): number => {
    let m = 0;
    for (const h of homeTransitions) {
      if (t >= h.month) m = h.month;
      else break;
    }
    return m;
  };

  // Post-retirement expenses are frozen at whatever last pre-retirement month's
  // total expenses were (no further growth, no inflation-only override unless
  // the user explicitly sets retirementAnnualSpend > 0).
  let lastPreRetirementExpenses = 0;
  let frozenRetiredExpenses: number | null = null;
  let cascadeFirstMonth = 0;

  for (let t = 1; t <= months; t++) {
    // Snapshot of net worth at the start of this month — used to compute
    // implicit investment growth (compounding) as a residual at the row push.
    const nwStartOfMonth = bal401k + balHsa + balEmergency + balHouse + bal529 + balBrokerage;
    const monthOfYear = ((t - 1) % 12) + 1;
    const year = Math.floor((t - 1) / 12) + 1;
    if (monthOfYear === 1) {
      ytdGross = 0;
      ytdTaxable = 0;
      ytd401k = 0;
      ytdHsa = 0;
      ytdEspp = 0;
      ytdSS = 0;
    }

    // Real-growth multipliers on top of inflation (0 = flat in today's $).
    const yearsElapsed = year - 1;
    const compMul = Math.pow(1 + I.salaryGrowth, yearsElapsed);
    const ineMul = Math.pow(1 + I.inelasticGrowth, yearsElapsed);
    const discMul = Math.pow(1 + I.discretionaryGrowth, yearsElapsed);
    const ssWageCap = I.ssWageCap;   // flat in real $ (inflation-indexed nominally)

    const retired = retirementMonth > 0 && t >= retirementMonth;
    // Filing status flips to MFJ at marriageMonth (if set). Brackets / std
    // deduction / MA exemption follow.
    const married = marriageMonth > 0 && t >= marriageMonth;
    const filingNow: "single" | "mfj" = married ? "mfj" : I.filingStatus;
    const fedBrackets = filingNow === "mfj" ? FED_BRACKETS_MFJ_2025 : FED_BRACKETS_SINGLE_2025;
    const fedStdDed = filingNow === "mfj" ? I.fedStdDeductionMFJ : I.fedStdDeductionSingle;
    const maExemption = filingNow === "mfj" ? I.maPersonalExemptionMFJ : I.maPersonalExemptionSingle;

    const baseMonthly = retired ? 0 : (I.baseSalaryAnnual * compMul) / 12;
    const bonusAmount = retired ? 0 : I.bonusAnnual * compMul;
    const sideMonthly = retired ? 0 : I.sideMonthlyCash * compMul;
    // Spouse income — only after marriage and before retirement. Grows at its
    // own real-raise rate, compounded annually like the user's salary.
    const spouseCompMul = married
      ? Math.pow(1 + (I.spouseSalaryGrowth ?? 0), Math.max(0, year - Math.ceil(marriageMonth / 12)))
      : 0;
    const spouseBaseMonthly = (married && !retired) ? ((I.spouseBaseAnnual ?? 0) * spouseCompMul) / 12 : 0;
    const spouseBonusAmount = (married && !retired) ? (I.spouseBonusAnnual ?? 0) * spouseCompMul : 0;
    const limit401kY = I.limit401k; // §402(g) limit indexed to inflation → flat in real $

    // iBase is the USER's base salary only — 401k % and ESPP % are computed
    // from it. Spouse income flows in via iSpouse → iGross below.
    const iBase = baseMonthly;
    const iBonus = (!retired && monthOfYear === I.bonusMonth) ? bonusAmount : 0;
    const iSide = (!retired && sideEndMonth > 0 && t <= sideEndMonth) ? sideMonthly : 0;
    const spouseBonusMonthHit = monthOfYear === (I.spouseBonusMonth ?? I.bonusMonth);
    const iSpouse = spouseBaseMonthly + (spouseBonusMonthHit ? spouseBonusAmount : 0);

    // Each vest's value today, grown at nominal market rate from now to month t,
    // then haircut-discounted to account for stock-price downside.
    let iRSU = 0;
    if (!retired) {
      // (1) Bonus / refresh grant — fixed vest schedule, grows at market rate.
      const v = rsuVestValueToday(I, t);
      if (v > 0) {
        const growth = Math.pow(1 + rNomM, t - 1);
        iRSU += v * growth * (1 - I.haircut);
      }
      // (2) Annual recurring stock — base + bonus, grows at salaryGrowth like
      // the rest of cash comp. Vests evenly across the year.
      const annualStock = ((I.annualStockBase ?? 0) + (I.annualStockBonus ?? 0)) * compMul;
      if (annualStock > 0) iRSU += (annualStock / 12) * (1 - I.haircut);
    }

    // ---- ESPP (sell-immediately) ----
    // Employee contributes esppRate × base from post-tax cash. Stock is purchased
    // at (1 - discount) of FMV; immediate sale recovers full FMV. The discount
    // portion is taxable W-2 income. The contribution itself is a wash (cash out
    // → stock → cash back), so the net P&L is just the post-tax discount, which
    // flows into the brokerage via the normal FCF waterfall.
    const purchaseValueRaw = (!retired && (1 - I.esppDiscount) > 0)
      ? (iBase * I.esppRate) / (1 - I.esppDiscount)
      : 0;
    const purchaseValue = Math.min(purchaseValueRaw, Math.max(0, I.esppAnnualCap - ytdEspp));
    const esppDiscountIncome = purchaseValue * I.esppDiscount;

    // iGross is the USER's gross only. Spouse income is held in iSpouse and
    // used solely to compute joint-filing tax brackets (prorated below).
    const iGross = iBase + iBonus + iSide + iRSU + esppDiscountIncome;

    // 401k employee contribution: either max-it-out (evenly across the year) or
    // a fixed % of base salary. Always capped by the remaining annual limit.
    // Contributions stop in retirement.
    const targetThisMonth = retired
      ? 0
      : (I.max401kAlways ? limit401kY / 12 : iBase * I.pct401k);
    const remaining401k = Math.max(0, limit401kY - ytd401k);
    let pmt401k = Math.min(targetThisMonth, remaining401k);
    // Employer match — on top of employee contrib, doesn't count against the
    // §402(g) elective-deferral limit (only against the §415(c) overall cap,
    // which we ignore here since 50% match × $23.5k is well under $70k).
    const empMatch = pmt401k * I.employerMatchRate;

    // Effective medical spend this month (respects optional step-down date).
    const medicalDropM = (I.medicalDropYear ?? 0) > 0 ? yearToMonth(I.medicalDropYear) : 0;
    const medicalMonthlyEff = medicalDropM > 0 && t >= medicalDropM
      ? (I.medicalAfterMonthly ?? 0)
      : effectiveExpenses(I).medical;

    // HSA: employee + employer share the annual limit (which grows with inflation).
    const hsaLimitY = I.hsaLimit;   // inflation-indexed → flat in real $
    const hsaEmpMonth = retired ? 0 : I.hsaEmployerAnnual / 12;
    const remainingHsa = Math.max(0, hsaLimitY - ytdHsa);
    const hsaEmp = Math.min(hsaEmpMonth, remainingHsa);
    // Auto-size mode: employee contribution targets (medical * 1.1) for the
    // year, net of the employer's share. Falls back to the manual hsaAnnual
    // when the toggle is off. Either way, capped by the IRS limit remaining.
    const medicalAnnualEff = medicalMonthlyEff * 12;
    const hsaTargetEmployeeAnnual = I.hsaAutoSize
      ? Math.max(0, Math.min(hsaLimitY, medicalAnnualEff * 1.1) - I.hsaEmployerAnnual)
      : I.hsaAnnual;
    let pmtHsa = retired
      ? 0
      : Math.min(hsaTargetEmployeeAnnual / 12, Math.max(0, remainingHsa - hsaEmp));

    // ---- FICA ----
    // HSA via cafeteria plan is excluded from FICA wages; 401(k) is not.
    const ficaWages = Math.max(0, iGross - pmtHsa);
    const ssRoom = Math.max(0, ssWageCap - ytdSS);
    const ssBase = Math.max(0, Math.min(ficaWages, ssRoom));
    const taxSS = 0.062 * ssBase;
    const taxMedBase = 0.0145 * ficaWages;
    const newYtdGross = ytdGross + iGross;
    const medSurThresh = filingNow === "mfj"
      ? (I.medicareSurtaxThresholdMFJ ?? I.medicareSurtaxThreshold)
      : I.medicareSurtaxThreshold;
    const surBase = Math.max(0, Math.min(ficaWages, newYtdGross - medSurThresh));
    const taxMedSur = 0.009 * surBase;
    const taxFICA = taxSS + taxMedBase + taxMedSur;

    // ---- Federal: 401k + HSA both deductible ----
    // Joint filing computes tax on COMBINED household taxable income, then
    // attributes the user's share by income proration (spouse pays their own
    // half independently — we don't model it in their finances).
    const userFedTaxable = Math.max(0, iGross - pmt401k - pmtHsa);
    const spouseFedTaxable = Math.max(0, iSpouse); // no 401k/HSA modeled for spouse
    const combinedFedTaxable = userFedTaxable + spouseFedTaxable;
    const annualizedFedCombined = Math.max(0, combinedFedTaxable * 12 - fedStdDed);
    const combinedFedTax = applyBrackets(annualizedFedCombined, fedBrackets) / 12;
    const userFedShare = combinedFedTaxable > 0 ? userFedTaxable / combinedFedTaxable : 1;
    const taxFedGross = combinedFedTax * userFedShare;

    // ---- Child Tax Credit ----
    // $2,000 per child under ctcChildMaxAge, phased out $50 per $1,000 of AGI
    // above threshold ($200k single / $400k MFJ). Nonrefundable — caps at fed
    // liability. Applied monthly as annualCTC/12 so it spreads evenly.
    let ctcEligible = 0;
    for (const c of I.children) {
      if (c.birthYear <= 0) continue;
      const birthM = yearToMonth(c.birthYear);
      const ageMonths = t - birthM;
      if (ageMonths < 0) continue;
      const ageYears = ageMonths / 12;
      if (ageYears < (I.ctcChildMaxAge ?? 17)) ctcEligible++;
    }
    const ctcThreshold = filingNow === "mfj" ? (I.ctcPhaseoutMFJ ?? 400000) : (I.ctcPhaseoutSingle ?? 200000);
    // Phase-out uses combined household AGI for MFJ; user pays the prorated
    // share of the (reduced) credit since the full credit applies to the joint
    // return, not each spouse separately.
    const annualAGIApprox = Math.max(0, combinedFedTaxable * 12);
    const ctcExcess = Math.max(0, annualAGIApprox - ctcThreshold);
    const ctcPhaseout = Math.ceil(ctcExcess / 1000) * 50;
    const ctcAnnualHousehold = Math.max(0, ctcEligible * (I.ctcPerChild ?? 2000) - ctcPhaseout);
    const ctcMonthly = (ctcAnnualHousehold / 12) * userFedShare;
    const taxFed = Math.max(0, taxFedGross - ctcMonthly);

    // ---- MA: 401k deductible, HSA is NOT (state doesn't conform) ----
    // Same joint-prorate treatment as federal. Spouse income is fully MA-taxable.
    const userMATaxable = Math.max(0, iGross - pmt401k);
    const spouseMATaxable = Math.max(0, iSpouse);
    const combinedMATaxable = userMATaxable + spouseMATaxable;
    const annualizedMA = Math.max(0, combinedMATaxable * 12 - maExemption);
    const taxMABaseCombined = (I.maRate * annualizedMA) / 12;
    const newYtdTaxable = ytdTaxable + combinedMATaxable;
    const surMA = Math.max(0, Math.min(combinedMATaxable, newYtdTaxable - I.maSurtaxThreshold));
    const taxMASurCombined = I.maSurtaxRate * surMA;
    const userMAShare = combinedMATaxable > 0 ? userMATaxable / combinedMATaxable : 1;
    const taxState = (taxMABaseCombined + taxMASurCombined) * userMAShare;
    // Track user's MA taxable for the per-row iTaxable field (legacy schema).
    const iMATaxable = userMATaxable;

    const iTaxable = userFedTaxable; // kept for the existing row schema
    const taxTotal = taxFICA + taxFed + taxState;
    const iNet = iGross - pmt401k - pmtHsa - taxTotal;

    // Housing: rent until home_purchase fires, then mortgage. Rent may come
    // from per-category overrides if any are present.
    //
    // Spouse share applies to (1) post-buy home costs and (2) rent after the
    // optional move-in date. Pre-move-in rent is fully on the user.
    const exp = effectiveExpenses(I);
    const housedYet = homeTransitions.length > 0 && t >= homeTransitions[0].month;
    const currentHomeValue = homeValueAt(t);
    // Convenience flag for the second-home block below — true if the user has
    // ANY upgrade scheduled and we've passed the very first one.
    const secondHomeMonth = homeTransitions.length > 1 ? homeTransitions[1].month : 0;
    const homeShare = 1 - Math.max(0, Math.min(1, I.spouseSharePct ?? 0));
    const moveInMonth = (I.spouseMoveInYear ?? 0) > 0 ? yearToMonth(I.spouseMoveInYear) : 0;
    const rentShare = moveInMonth > 0 && t >= moveInMonth
      ? 1 - Math.max(0, Math.min(1, I.spouseRentSharePct ?? 0))
      : 1;
    const currentMortgagePI = housedYet
      ? mortgagePaymentFor(currentHomeValue, I.houseDownPaymentPct, I.mortgageRate, I.mortgageTermYears)
      : 0;
    const currentCarrying = housedYet
      ? (currentHomeValue * ((I.propertyTaxRate ?? 0) + (I.homeInsuranceRate ?? 0) + (I.maintenanceRate ?? 0))) / 12 + (I.hoaMonthly ?? 0)
      : 0;
    const housingMonthly = housedYet
      ? (currentMortgagePI + currentCarrying) * homeShare
      : exp.rent * rentShare;
    const taxProperty = housedYet
      ? (currentHomeValue * (I.propertyTaxRate ?? 0) / 12) * homeShare
      : 0;

    // Active kids = born and within kidYears of birth. Per-child monthly cost.
    // Legacy scenarios saved before per-child cost existed fall back to the
    // old global costPerKidMonthly.
    let kidCostRaw = 0;
    for (const c of I.children) {
      if (c.birthYear > 0 && t >= yearToMonth(c.birthYear) && t < yearToMonth(c.birthYear + I.kidYears)) {
        kidCostRaw += c.monthlyCost ?? 0;
      }
    }
    const kidCost = kidCostRaw * homeShare;

    // HSA pays qualified medical first (tax-free draw). Anything HSA can't
    // cover becomes a regular cash expense. `hsaAvailForMedical` reflects this
    // month's HSA balance after employee + employer contributions; medical is
    // deducted from HSA before market-rate compounding (we apply compounding
    // post-deduction below).
    const hsaAvailForMedical = Math.max(0, balHsa + pmtHsa + hsaEmp);
    const medicalTotal = medicalMonthlyEff;
    const hsaForMedical = Math.min(medicalTotal, hsaAvailForMedical);
    const medicalNotCovered = Math.max(0, medicalTotal - hsaForMedical);

    // housingMonthly and kidCost are already pre-multiplied by their respective
    // spouse-share factors. Inelastic + discretionary are personal. Medical
    // not covered by HSA becomes a cash expense this month.
    // Recurring ownership costs from active goals. Tracked per-goal so the
    // annual table can render one column per goal.
    const goalOwnershipByGoal: { goalId: string; amount: number }[] = [];
    let goalOwnershipMonthly = 0;
    for (const g of I.goals) {
      const monthly = g.ownershipMonthly ?? 0;
      if (monthly <= 0) continue;
      if (g.startYear <= 0) continue;
      const startM = yearToMonth(g.startYear);
      if (t < startM) continue;
      // For car goals, ownership ends when a later car goal fires (replacement).
      if (g.kind === "car") {
        const replaced = I.goals.some((g2) =>
          g2.kind === "car" && g2.id !== g.id && g2.startYear > g.startYear && t >= yearToMonth(g2.startYear),
        );
        if (replaced) continue;
      } else if (g.endYear && t >= yearToMonth(g.endYear)) {
        continue;
      }
      goalOwnershipMonthly += monthly;
      goalOwnershipByGoal.push({ goalId: g.id, amount: monthly });
    }
    const normalExpenses = housingMonthly + exp.inelastic * ineMul + exp.discretionary * discMul + kidCost + medicalNotCovered + goalOwnershipMonthly;
    let expenses: number;
    if (!retired) {
      expenses = normalExpenses;
      lastPreRetirementExpenses = normalExpenses;
    } else if (I.retirementExpenseMode === "manual") {
      // Hard-coded flat monthly real-$ retirement spend (personal — not
      // automatically shared with spouse; set the value as your own share).
      expenses = I.retirementAnnualSpend / 12;
    } else {
      // "snapshot": freeze at the final pre-retirement month's expenses.
      if (frozenRetiredExpenses === null) frozenRetiredExpenses = lastPreRetirementExpenses;
      expenses = frozenRetiredExpenses;
    }
    const fcf = iNet - expenses;

    // ---- Waterfall ----
    // Priority order (positive FCF): emergency fund → 529 birth lump → house
    // fund → brokerage overflow. Negative FCF (typically post-retirement): drawdown
    // is recorded as a negative brokerage payment.
    let pmtEmergency = 0;
    let pmtHouse = 0;
    let pmt529 = 0;
    let pmtBrokerage = 0;
    let taxCapGains = 0;
    const houseCashNeeded = houseCashTarget(I) * homeShare;
    // Emergency fund covers the FORECASTED next-N-months of normal monthly
    // expenses (housing + inelastic + discretionary + active-kid step-up),
    // honoring real growth and the rent→mortgage transition. Big lump-sum
    // goals (car, down payment, etc.) are intentionally excluded — they
    // come out of brokerage / house fund, not the EF.
    const emergencyTarget = (() => {
      let sum = 0;
      for (let k = 1; k <= I.emergencyMonths; k++) {
        const tt = t + k;
        const yElapsed = Math.floor((tt - 1) / 12);
        const ineMulF = Math.pow(1 + I.inelasticGrowth, yElapsed);
        const discMulF = Math.pow(1 + I.discretionaryGrowth, yElapsed);
        const currentValueF = homeValueAt(tt);
        const housedF = currentValueF > 0;
        const rentShareF = moveInMonth > 0 && tt >= moveInMonth
          ? 1 - Math.max(0, Math.min(1, I.spouseRentSharePct ?? 0))
          : 1;
        const piF = mortgagePaymentFor(currentValueF, I.houseDownPaymentPct, I.mortgageRate, I.mortgageTermYears);
        const carryF = (currentValueF * ((I.propertyTaxRate ?? 0) + (I.homeInsuranceRate ?? 0) + (I.maintenanceRate ?? 0))) / 12 + (I.hoaMonthly ?? 0);
        const housingF = housedF ? (piF + carryF) * homeShare : exp.rent * rentShareF;
        let kidsCostF = 0;
        for (const c of I.children) {
          if (c.birthYear > 0 && tt >= yearToMonth(c.birthYear) && tt < yearToMonth(c.birthYear + I.kidYears)) {
            kidsCostF += c.monthlyCost ?? 0;
          }
        }
        sum += housingF + exp.inelastic * ineMulF + exp.discretionary * discMulF + kidsCostF * homeShare;
      }
      return sum;
    })();
    if (fcf >= 0) {
      let remaining = fcf;
      // 1. Emergency fund (N months of current total expenses).
      if (balEmergency < emergencyTarget) {
        pmtEmergency = Math.min(remaining, emergencyTarget - balEmergency);
        remaining -= pmtEmergency;
      }
      // 2. 529 contributions: lump at birth, fixed monthly stream, OR auto-
      //    sized to fully fund the kid's college over the years until they
      //    start. All three modes draw against this priority slot.
      let need529 = 0;
      const lumpChild = childLumpAtBirth.get(t);
      if (lumpChild) need529 += lumpChild.amount529;
      for (const c of I.children) {
        const mode = c.contribMode529 ?? "lump";
        if (mode === "monthly") {
          if (c.birthYear <= 0) continue;
          const birthM = yearToMonth(c.birthYear);
          const endM = yearToMonth(c.birthYear + (c.contribUntilYears ?? 18));
          if (t >= birthM && t < endM) need529 += c.amount529;
        } else if (mode === "auto") {
          // Target: fund the user's share of total college tuition by the
          // time college starts. Annuity payment formula:
          //   PMT = FV × r / ((1+r)^n − 1)  (r=0 → FV/n).
          // Contribute from plan-start through one month before college.
          const cost = c.collegeAnnualCost ?? 0;
          if (cost <= 0 || c.birthYear <= 0) continue;
          const startAge = c.collegeStartAge ?? 18;
          const dur = c.collegeDurationYears ?? 4;
          const birthM = yearToMonth(c.birthYear);
          const birthPlanY = Math.max(1, Math.ceil(birthM / 12));
          const collegeStartM = (birthPlanY - 1 + startAge) * 12 + 1;
          if (t >= collegeStartM) continue;
          const userShareOfTuition = 1 - Math.max(0, Math.min(1, I.spouseCollegeSharePct ?? 0));
          const targetFV = cost * dur * userShareOfTuition;
          const nMonths = Math.max(1, collegeStartM - 1);
          const pmt = rNomM > 0
            ? (targetFV * rNomM) / (Math.pow(1 + rNomM, nMonths) - 1)
            : targetFV / nMonths;
          // need529 is multiplied by homeShare below; "auto" is already
          // user-share-scaled, so divide back so the post-multiply gives pmt.
          const homeShareSafe = homeShare > 0 ? homeShare : 1;
          need529 += pmt / homeShareSafe;
        }
      }
      // 529 contributions are kid-related → shared with spouse (skipped for
      // "auto" because it's pre-scaled to user share).
      need529 *= homeShare;
      if (need529 > 0) {
        pmt529 = Math.min(remaining, need529);
        remaining -= pmt529;
      }
      // 3. House fund auto-fills until the cash target is hit. Stops once the
      //    home has been purchased — house fund no longer has a purpose after
      //    that (everything spills to brokerage).
      const houseFundActive = firstHomePurchaseMonth === 0 || t < firstHomePurchaseMonth;
      if (houseFundActive && balHouse < houseCashNeeded) {
        pmtHouse = Math.min(remaining, houseCashNeeded - balHouse);
        remaining -= pmtHouse;
      }
      // 4. Brokerage absorbs the rest.
      pmtBrokerage = remaining;
    } else {
      // Negative FCF — fund the deficit by selling assets. Pre-retirement: from
      // brokerage only. Post-retirement: draw 401k FIRST (it's now ordinary
      // income with no penalty, and we want to actually see the 401k decumulate
      // instead of letting market returns keep compounding it). Brokerage is
      // the post-tax LTCG fallback once the 401k is drained.
      const cgRate = Math.min(0.5, Math.max(0, I.capGainsTaxRate ?? 0));
      if (retired) {
        let need = -fcf;
        if (bal401k > 0 && need > 0) {
          const wdRate = Math.min(0.5, Math.max(0, I.retirementWithdrawTaxRate ?? 0));
          const grossNeeded = need / (1 - wdRate);
          const grossTake = Math.min(grossNeeded, bal401k);
          const netTake = grossTake * (1 - wdRate);
          pmt401k = -grossTake;
          need -= netTake;
        }
        if (need > 0) {
          const grossNeeded = need / (1 - cgRate);
          pmtBrokerage = -grossNeeded;
          taxCapGains += grossNeeded - need;
        }
      } else {
        const need = -fcf;
        pmtBrokerage = fcf / (1 - cgRate);
        taxCapGains += (-pmtBrokerage) - need;
      }
    }

    bal401k = bal401k * (1 + rNomM) + pmt401k + empMatch;
    // HSA: contribute, withdraw for medical (tax-free), then compound the rest.
    // Reflect the medical draw in pmtHsa so the "HSA net" column shows net flow.
    balHsa = (balHsa + pmtHsa + hsaEmp - hsaForMedical) * (1 + rNomM);
    pmtHsa -= hsaForMedical;
    balEmergency = balEmergency * (1 + rSafeM) + pmtEmergency;
    balHouse = balHouse * (1 + rSafeM) + pmtHouse;
    bal529 = bal529 * (1 + rNomM) + pmt529;
    balBrokerage = balBrokerage * (1 + rNomM) + pmtBrokerage;

    // Per-month list of one-time / unusual withdrawals — powers the Notes
    // column in the annual summary. Populated by both the cascade and the
    // goal-withdrawal loop.
    const monthGoalEvents: { name: string; source?: string; amount: number }[] = [];
    let monthGoalWithdrawals = 0;
    let monthCollegePaid = 0;

    // ---- Cascading drawdown when brokerage goes negative ----
    // Order is "easy access" first, "tax-penalized" last:
    //   emergency fund → house fund → 529 → 401k → HSA
    // (Pre-59½ 401k/HSA withdrawals carry real penalties; this drains them only
    // as a last resort. Tax on retirement-account withdrawals isn't separately
    // applied — treat the projection as already-net.)
    //
    // Each draw also adjusts the corresponding pmt counter for the month so
    // the annual summary's flow columns reflect the NET allocation (e.g. a
    // -$1k deficit refilled from house fund shows up as pmtHouse -$1k and
    // pmtBrokerage 0, not pmtHouse $0 and pmtBrokerage -$1k).
    // Cascade helper — drains the shortfall (negative balBrokerage) through
    // emergency → house → 529 → 401k → HSA, applying each bucket's withdrawal
    // tax. Returns nothing; mutates balances and pmt counters in place.
    const runCascade = () => {
      if (balBrokerage >= 0) return;
      if (cascadeFirstMonth === 0) cascadeFirstMonth = t;
      const shortfall = -balBrokerage;
      let need = shortfall;
      balBrokerage = 0;
      const taxOn = (bucket: "emergency" | "house" | "529" | "401k" | "hsa"): number => {
        if (bucket === "emergency" || bucket === "house") return 0;
        if (bucket === "529") return Math.max(0, I.capGainsTaxRate ?? 0) + 0.10;
        if (bucket === "401k") {
          const base = Math.max(0, I.retirementWithdrawTaxRate ?? 0);
          const penalty = retired ? 0 : Math.max(0, I.earlyWithdrawPenalty ?? 0);
          return Math.min(0.6, base + penalty);
        }
        return 0;
      };
      const drawFromBucket = (
        bucket: "emergency" | "house" | "529" | "401k" | "hsa",
        bal: number,
        setBal: (v: number) => void,
        adjustPmt?: (gross: number) => void,
        noteName?: string,
      ) => {
        if (need <= 0 || bal <= 0) return;
        const rate = taxOn(bucket);
        const grossNeeded = need / (1 - rate);
        const grossTake = Math.min(grossNeeded, bal);
        const netTake = grossTake * (1 - rate);
        setBal(bal - grossTake);
        if (adjustPmt) adjustPmt(grossTake);
        if (noteName && grossTake > 0) monthGoalEvents.push({ name: noteName, amount: grossTake });
        if (rate > 0) taxCapGains += grossTake - netTake;
        need -= netTake;
      };
      drawFromBucket("emergency", balEmergency, (v) => { balEmergency = v; }, (g) => { pmtEmergency -= g; });
      drawFromBucket("house", balHouse, (v) => { balHouse = v; }, (g) => { pmtHouse -= g; });
      drawFromBucket("529", bal529, (v) => { bal529 = v; }, (g) => { pmt529 -= g; }, "529 non-qualified");
      drawFromBucket("401k", bal401k, (v) => { bal401k = v; }, (g) => { pmt401k -= g; }, retired ? "401k withdrawal" : "401k early withdrawal");
      drawFromBucket("hsa", balHsa, (v) => { balHsa = v; }, (g) => { pmtHsa -= g; }, "HSA withdrawal");
      const refilled = shortfall - need;
      pmtBrokerage += refilled;
      if (need > 0) balBrokerage = -need;
    };
    runCascade();

    // ---- Home purchase withdrawal (one-time event on firstHomePurchaseMonth) ----
    // House fund is cash → no tax. Brokerage fallback realizes capital gains.
    let homePurchaseDraw = 0;
    if (firstHomePurchaseMonth > 0 && t === firstHomePurchaseMonth) {
      let need = houseCashTarget(I) * homeShare;
      const fromHouse = Math.min(need, Math.max(0, balHouse));
      balHouse -= fromHouse;
      pmtHouse -= fromHouse;
      need -= fromHouse;
      if (need > 0 && balBrokerage > 0) {
        const cgRate = Math.max(0, Math.min(0.5, I.capGainsTaxRate ?? 0));
        const grossNeeded = need / (1 - cgRate);
        const grossTake = Math.min(grossNeeded, balBrokerage);
        const netTake = grossTake * (1 - cgRate);
        balBrokerage -= grossTake;
        pmtBrokerage -= grossTake;
        taxCapGains += grossTake - netTake;
        need -= netTake;
        homePurchaseDraw = fromHouse + grossTake;
      } else {
        homePurchaseDraw = fromHouse;
      }
      // Sweep any remaining house fund into brokerage — its purpose was the
      // down payment + closing; leftover cash shouldn't sit idle.
      if (balHouse > 0) {
        const sweep = balHouse;
        balHouse = 0;
        pmtHouse -= sweep;
        balBrokerage += sweep;
        pmtBrokerage += sweep;
      }
    }

    // ---- Home upgrades: sell current, buy new (one-time event each) ----
    // For each transition after the first, on its month: (1) sell the current
    // home, paying off its remaining mortgage and selling-cost fees, (2) buy
    // the new home, drawing the cash target from house fund + brokerage, (3)
    // sweep leftover house fund into brokerage. Real values flat; mortgage
    // amortization closed-form based on time since the previous transition.
    for (let i = 1; i < homeTransitions.length; i++) {
      const upgrade = homeTransitions[i];
      if (t !== upgrade.month) continue;
      const prev = homeTransitions[i - 1];
      const monthsOwned = upgrade.month - prev.month;
      const remainingMortgage = mortgageBalance(
        prev.value, I.houseDownPaymentPct, I.mortgageRate, I.mortgageTermYears,
        monthsOwned,
      );
      const sellingFees = prev.value * (I.sellingClosingCostPct ?? 0.07);
      const netProceeds = Math.max(0, prev.value - sellingFees - remainingMortgage) * homeShare;
      balHouse += netProceeds;
      pmtHouse += netProceeds;
      monthGoalEvents.push({ name: `Sell home #${i} (net)`, amount: netProceeds });

      let need = upgrade.value * (I.houseDownPaymentPct + I.houseClosingCostPct) * homeShare;
      const fromHouse = Math.min(need, Math.max(0, balHouse));
      balHouse -= fromHouse;
      pmtHouse -= fromHouse;
      need -= fromHouse;
      let upgradeDraw = fromHouse;
      if (need > 0 && balBrokerage > 0) {
        const cgRate = Math.max(0, Math.min(0.5, I.capGainsTaxRate ?? 0));
        const grossNeeded = need / (1 - cgRate);
        const grossTake = Math.min(grossNeeded, balBrokerage);
        balBrokerage -= grossTake;
        pmtBrokerage -= grossTake;
        taxCapGains += grossTake - grossTake * (1 - cgRate);
        upgradeDraw += grossTake;
      }
      monthGoalEvents.push({ name: `Buy home #${i + 1}`, amount: upgradeDraw });
      if (balHouse > 0) {
        const sweep = balHouse;
        balHouse = 0;
        pmtHouse -= sweep;
        balBrokerage += sweep;
        pmtBrokerage += sweep;
      }
    }

    // ---- Apply scheduled goal withdrawals ----
    // Each goal draws first from its kind-specific bucket, then falls back to
    // the brokerage. Draws reduce the bucket pmt counters directly so the
    // annual flow columns show the net allocation. Goal events are appended to
    // `monthGoalEvents` (declared earlier so the cascade can use it too).
    for (const g of allGoals) {
      const sched = goalSchedule.get(g.id);
      if (!sched) continue;
      if (t < sched.startM || t > sched.endM) continue;
      // Only kid-related goals (kid_yearly, college) are spouse-shared.
      // College uses its own dedicated share (spouseCollegeSharePct) since
      // tuition split often differs from the general home + kids split.
      // Car / other are personal.
      let goalShare = 1;
      if (g.kind === "kid_yearly") goalShare = homeShare;
      else if (g.kind === "college") {
        goalShare = 1 - Math.max(0, Math.min(1, I.spouseCollegeSharePct ?? 0));
      }
      let need = sched.perMonth * goalShare;
      // Auto-remainder: at the scheduled time(s), draw whatever's available in
      // the bucket that would normally fund this kind of goal (and brokerage as
      // fallback). For one-time auto goals: drains available cash at that month.
      if (g.autoRemainder) {
        if (g.kind === "home_purchase") need = Math.max(0, balHouse) + Math.max(0, balBrokerage);
        else if (g.kind === "college") need = Math.max(0, bal529) + Math.max(0, balBrokerage);
        else need = Math.max(0, balBrokerage);
      }
      const status = goalStatuses.get(g.id)!;
      status.scheduled += need;
      let toDraw = need;

      // `mustPay` goals (college tuition) cover the full amount even when the
      // primary bucket is empty — brokerage absorbs the rest, going negative if
      // needed. The subsequent cascade refills brokerage from other accounts.
      const mustPay = g.kind === "college";

      const drawFrom = (
        which: "house" | "529" | "brokerage",
      ) => {
        if (toDraw <= 0) return;
        let avail = 0;
        if (which === "house") avail = balHouse;
        else if (which === "529") avail = bal529;
        else avail = balBrokerage;
        const rate = which === "brokerage" ? Math.max(0, Math.min(0.5, I.capGainsTaxRate ?? 0)) : 0;
        const grossNeeded = toDraw / (1 - rate);
        // mustPay + brokerage: take the full amount even if balance is short.
        // Otherwise cap at available balance.
        const grossTake = (mustPay && which === "brokerage")
          ? grossNeeded
          : Math.min(grossNeeded, Math.max(0, avail));
        const netTake = grossTake * (1 - rate);
        if (which === "house") { balHouse -= grossTake; pmtHouse -= grossTake; }
        else if (which === "529") { bal529 -= grossTake; pmt529 -= grossTake; }
        else { balBrokerage -= grossTake; pmtBrokerage -= grossTake; }
        if (which === "brokerage") taxCapGains += grossTake - netTake;
        toDraw -= netTake;
        status.withdrawn += netTake;
        monthGoalWithdrawals += grossTake;
        if (g.kind === "college") monthCollegePaid += grossTake;
        monthGoalEvents.push({ name: g.name, source: which, amount: grossTake });
      };

      if (g.kind === "home_purchase") {
        drawFrom("house");
        drawFrom("brokerage");
      } else if (g.kind === "college") {
        drawFrom("529");
        drawFrom("brokerage");
      } else {
        drawFrom("brokerage");
      }
      if (!mustPay && toDraw > 1e-6) status.shortfall += toDraw;
    }
    // After goal withdrawals, brokerage may have gone negative (must-pay
    // college goals). Run the cascade again to drain it from emergency / 401k /
    // HSA / etc., same priority as the post-deficit cascade.
    runCascade();

    ytdGross = newYtdGross;
    ytdTaxable = newYtdTaxable;
    ytd401k += pmt401k;
    ytdHsa += pmtHsa + hsaEmp;
    ytdEspp += purchaseValue;
    ytdSS += ssBase;

    const netWorthEnd = bal401k + balHsa + balEmergency + balHouse + bal529 + balBrokerage;
    // Sum of net cash flows INTO accounts this month. pmtHsa already has
    // hsaForMedical netted in (see HSA compounding step above), so it's
    // accounted for here.
    const totalNetFlows = pmt401k + empMatch + pmtHsa + hsaEmp
                        + pmtEmergency + pmtHouse + pmt529 + pmtBrokerage;
    // Investment growth = bal change - net contributions. The residual is the
    // compounding contribution; reconciles graph (raw balances) with table.
    const investmentGrowth = netWorthEnd - nwStartOfMonth - totalNetFlows;

    rows.push({
      t, year, monthOfYear,
      iBase, iBonus, iSide, iRSU, iGross,
      pmt401k, empMatch, pmtHsa, hsaEmp, esppDiscountIncome,
      taxFICA, iTaxable, taxFed, taxState, taxProperty, taxCapGains, taxTotal,
      iNet, fcf,
      housingPaid: housingMonthly,
      inelasticPaid: exp.inelastic * ineMul,
      discretionaryPaid: exp.discretionary * discMul,
      kidCostPaid: kidCost,
      collegePaid: monthCollegePaid,
      medicalFromHsa: hsaForMedical,
      investmentGrowth,
      goalOwnershipByGoal,
      expensesTotal: expenses,
      goalWithdrawals: monthGoalWithdrawals + homePurchaseDraw,
      goalEvents: homePurchaseDraw > 0
        ? [...monthGoalEvents, { name: "Home purchase", amount: homePurchaseDraw }]
        : monthGoalEvents,
      pmtHouse, pmt529, pmtBrokerage,
      bal401k, balHsa, balEmergency, balHouse, bal529, balBrokerage,
      pmtEmergency,
      netWorth: netWorthEnd,
    });
  }
  // Detect post-retirement brokerage depletion (a simple "running out" check).
  let brokerageDepleteYear: number | null = null;
  if (retirementMonth > 0) {
    for (const r of rows) {
      // Truly depleted = brokerage went negative (cascade through 401k/HSA/etc
      // couldn't cover the gap) OR every drawable bucket is at 0.
      const liquid = r.bal401k + r.balHsa + r.balEmergency + r.balHouse + r.bal529 + r.balBrokerage;
      if (r.t >= retirementMonth && (r.balBrokerage < 0 || liquid <= 0)) {
        brokerageDepleteYear = +((r.t - 1) / 12 + 1 / 12).toFixed(2);
        break;
      }
    }
  }
  const cascadeYear = cascadeFirstMonth > 0
    ? +((cascadeFirstMonth - 1) / 12 + 1 / 12).toFixed(2)
    : null;
  return { rows, goals: Array.from(goalStatuses.values()), retirementMonth, brokerageDepleteYear, cascadeYear };
}

const fmt = (n: number) => "$" + Math.round(n).toLocaleString();
const fmtK = (n: number) =>
  Math.abs(n) >= 1000 ? "$" + (n / 1000).toFixed(0) + "k" : "$" + n.toFixed(0);

const LEGACY_INPUTS_KEY = "budget-v2-planning-inputs";
const SCENARIOS_KEY = "budget-v2-planning-scenarios";

function mergeInputs(saved: Partial<Inputs> | null): Inputs {
  if (!saved) return DEFAULTS;
  const merged: Inputs = { ...DEFAULTS, ...saved };
  if (!Array.isArray(merged.children)) merged.children = DEFAULTS.children;
  if (!Array.isArray(merged.additionalHomes)) merged.additionalHomes = [];
  // Migrate: children without per-child monthlyCost inherit the legacy global
  // `costPerKidMonthly` so old scenarios don't suddenly show $0 in the Kids
  // column. New children created post-migration default to monthlyCost.
  const legacyKidCost = (saved as Partial<Inputs>)?.costPerKidMonthly;
  if (typeof legacyKidCost === "number" && legacyKidCost > 0) {
    merged.children = merged.children.map((c) =>
      typeof c.monthlyCost === "number" && c.monthlyCost > 0 ? c : { ...c, monthlyCost: legacyKidCost }
    );
  }
  if (!Array.isArray(merged.goals)) merged.goals = DEFAULTS.goals;
  // Migrate legacy data: lift any home_purchase Goal into the top-level
  // homePurchaseYear field, then strip it from the goals list.
  const legacyHome = merged.goals.find((g) => g.kind === "home_purchase");
  if (legacyHome) {
    if (!merged.homePurchaseYear || merged.homePurchaseYear <= 0) {
      merged.homePurchaseYear = legacyHome.startYear;
    }
    merged.goals = merged.goals.filter((g) => g.kind !== "home_purchase");
  }
  if (!Array.isArray(merged.categoryOverrides)) merged.categoryOverrides = [];
  if (typeof merged.categoriesImportedYM !== "string") {
    // Migrate from old `categoriesImported: boolean`.
    const legacy = (saved as Record<string, unknown>)?.categoriesImported;
    merged.categoriesImportedYM = legacy ? todayYM() : "";
  }
  if (!merged.planStartDate) merged.planStartDate = todayYM();
  // Backfill any numeric field that's missing or NaN, so adding new fields to
  // Inputs doesn't break old saved scenarios.
  for (const k of Object.keys(DEFAULTS) as (keyof Inputs)[]) {
    const v = merged[k] as unknown;
    if (typeof DEFAULTS[k] === "number" && (typeof v !== "number" || !Number.isFinite(v))) {
      (merged as unknown as Record<string, unknown>)[k] = DEFAULTS[k];
    }
  }
  return merged;
}

// Re-anchor every year-offset field so the plan always starts at the CURRENT
// month while preserving all the absolute calendar dates the user set. If the
// saved planStartDate was 2026-05 and today is 2026-12, every "years from
// plan start" field is shifted by −7 months so it still points to the same
// real-world date.
function reanchorInputs(inputs: Inputs): Inputs {
  const today = todayYM();
  if (inputs.planStartDate === today) return inputs;
  const oldYM = parseYM(inputs.planStartDate);
  const newYM = parseYM(today);
  if (!oldYM || !newYM) return { ...inputs, planStartDate: today };
  const deltaMonths = (newYM.y - oldYM.y) * 12 + (newYM.m - oldYM.m);
  if (deltaMonths === 0) return { ...inputs, planStartDate: today };
  const deltaY = deltaMonths / 12;
  const shift = (v: number | undefined): number => {
    if (typeof v !== "number" || v === 0) return v ?? 0;
    return Math.max(0, v - deltaY);
  };
  const shifted: Inputs = {
    ...inputs,
    planStartDate: today,
    homePurchaseYear: shift(inputs.homePurchaseYear),
    secondHomeYear: shift(inputs.secondHomeYear),
    retirementYear: shift(inputs.retirementYear),
    marriageYear: shift(inputs.marriageYear),
    medicalDropYear: shift(inputs.medicalDropYear),
    sideEndYear: shift(inputs.sideEndYear),
    spouseMoveInYear: shift(inputs.spouseMoveInYear),
    rsuFirstVestYear: shift(inputs.rsuFirstVestYear),
    additionalHomes: (inputs.additionalHomes ?? []).map((h) => ({ ...h, year: shift(h.year) })),
    children: inputs.children.map((c) => ({ ...c, birthYear: shift(c.birthYear) })),
    goals: inputs.goals.map((g) => ({
      ...g,
      startYear: shift(g.startYear),
      endYear: typeof g.endYear === "number" ? shift(g.endYear) : g.endYear,
    })),
  };
  return shifted;
}

interface Scenario {
  id: string;
  name: string;
  inputs: Inputs;
}
interface ScenarioStore {
  scenarios: Scenario[];
  activeId: string;
  baselineId?: string;
}

function loadScenarioStore(): ScenarioStore {
  // Preferred: new scenarios store.
  try {
    const raw = localStorage.getItem(SCENARIOS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ScenarioStore;
      if (parsed?.scenarios?.length) {
        parsed.scenarios = parsed.scenarios.map((s) => ({ ...s, inputs: mergeInputs(s.inputs) }));
        if (!parsed.scenarios.find((s) => s.id === parsed.activeId)) {
          parsed.activeId = parsed.scenarios[0].id;
        }
        return parsed;
      }
    }
  } catch {}
  // Migrate: legacy single-inputs blob → "Current plan" scenario.
  try {
    const legacy = localStorage.getItem(LEGACY_INPUTS_KEY);
    if (legacy) {
      const inputs = mergeInputs(JSON.parse(legacy));
      const id = "s" + Math.random().toString(36).slice(2, 8);
      return { scenarios: [{ id, name: "Current plan", inputs }], activeId: id };
    }
  } catch {}
  const id = "s" + Math.random().toString(36).slice(2, 8);
  return { scenarios: [{ id, name: "Current plan", inputs: DEFAULTS }], activeId: id };
}

// ===================== UI helpers =====================

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Two-field calendar picker (month dropdown + year input). Stores a decimal-year
// offset from planStartDate (0 = plan start month). With `allowNone`, an empty
// or invalid year is treated as "not set". More robust than <input type=month>,
// which has inconsistent UX across browsers.
function DateField({ label, valueYears, onChange, planStart, hint, allowNone }: {
  label: string;
  valueYears: number;
  onChange: (years: number) => void;
  planStart: string;
  hint?: string;
  allowNone?: boolean;
}) {
  const isNone = allowNone && valueYears <= 0;
  const ym = isNone ? null : parseYM(yearOffsetToYM(valueYears, planStart));
  const month = ym ? ym.m : 1;
  const year = ym ? ym.y : (parseYM(planStart)?.y ?? new Date().getFullYear());

  const apply = (y: number, m: number) => {
    if (!y || y < 1900 || y > 2200) {
      if (allowNone) onChange(0);
      return;
    }
    onChange(ymToYearOffset(`${y}-${String(m).padStart(2, "0")}`, planStart));
  };

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-neutral-400">{label}</span>
      <div className="flex items-center gap-1">
        <select
          value={isNone ? "" : String(month)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onChange(0);
            else apply(year, Number(v));
          }}
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100 w-[5.5rem]"
        >
          {allowNone && <option value="">—</option>}
          {MONTH_NAMES.map((name, i) => (
            <option key={i} value={i + 1}>{name}</option>
          ))}
        </select>
        <select
          value={isNone ? "" : String(year)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") { if (allowNone) onChange(0); return; }
            apply(parseInt(v, 10), month);
          }}
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100 w-[5.5rem]"
        >
          {allowNone && <option value="">—</option>}
          {(() => {
            const baseYear = parseYM(planStart)?.y ?? new Date().getFullYear();
            const opts: number[] = [];
            // Range: from 5 years before plan start to 80 years after.
            for (let y = baseYear - 5; y <= baseYear + 80; y++) opts.push(y);
            return opts.map((y) => <option key={y} value={y}>{y}</option>);
          })()}
        </select>
        {allowNone && !isNone && (
          <button
            type="button"
            onClick={() => onChange(0)}
            className="text-[10px] text-neutral-500 hover:text-rose-400 px-1"
            title="Clear"
          >
            ✕
          </button>
        )}
      </div>
      <span className="text-[10px] text-neutral-500">
        {isNone ? "none" : relativeDescription(valueYears)}
        {hint ? ` · ${hint}` : ""}
      </span>
    </label>
  );
}

function NumField({ label, value, onChange, step, suffix, hint }: {
  label: string; value: number; onChange: (n: number) => void;
  step?: number; suffix?: string; hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-neutral-400">{label}{suffix ? ` (${suffix})` : ""}</span>
      <input
        type="number"
        step={step ?? "any"}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
      />
      {hint && <span className="text-[10px] text-neutral-500">{hint}</span>}
    </label>
  );
}

function SidebarGroup({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <details open className="border border-neutral-800 rounded-lg overflow-hidden">
      <summary className="cursor-pointer text-xs uppercase tracking-wider text-neutral-200 px-3 py-2 bg-neutral-900/40 hover:bg-neutral-900 flex items-center justify-between">
        <span>{title}</span>
        {action && <span onClick={(e) => e.preventDefault()}>{action}</span>}
      </summary>
      <div className="p-3 space-y-3">{children}</div>
    </details>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider text-neutral-400">{title}</h3>
        {action}
      </div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-neutral-800 rounded-lg p-3">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-neutral-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="border border-neutral-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-neutral-300">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

// ===================== Awards editor =====================

function StockSection({
  I, patch,
}: { I: Inputs; patch: (p: Partial<Inputs>) => void }) {
  const perVest = I.rsuTotalVests > 0 ? I.rsuTotalValue / I.rsuTotalVests : 0;
  const lastYear = I.rsuFirstVestYear + (I.rsuTotalVests - 1) / (I.rsuVestsPerYear || 1);
  return (
    <div className="border border-neutral-800 rounded-lg p-3 space-y-3">
      <h3 className="text-xs uppercase tracking-wider text-neutral-400">Stock Awards (RSU)</h3>

      <div className="space-y-2">
        <div className="text-[11px] text-neutral-300 font-medium">Remaining bonus RSUs (one-time pool)</div>
        <p className="text-[10px] text-neutral-500 leading-tight">
          Sum the total unvested $ today across your existing sign-on / refresh grants,
          then pick a representative schedule. The model spreads it across vest events.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Remaining unvested $" value={I.rsuTotalValue} onChange={(v) => patch({ rsuTotalValue: v })} hint="today's value, all grants" />
          <NumField label="Total # vests" value={I.rsuTotalVests} onChange={(v) => patch({ rsuTotalVests: v })} />
          <DateField label="First vest" valueYears={I.rsuFirstVestYear} onChange={(v) => patch({ rsuFirstVestYear: v })} planStart={I.planStartDate} />
          <NumField label="Vests / year" value={I.rsuVestsPerYear} onChange={(v) => patch({ rsuVestsPerYear: v })} hint="4 = quarterly" />
        </div>
        <div className="text-[10px] text-neutral-500">
          {I.rsuTotalVests > 0
            ? <>{fmt(perVest)} / vest (today&apos;s $) · last vest ≈ {yearOffsetToYM(lastYear, I.planStartDate)}</>
            : "—"}
        </div>
      </div>

      <div className="space-y-2 border-t border-neutral-800 pt-3">
        <div className="text-[11px] text-neutral-300 font-medium">Annual recurring stock</div>
        <p className="text-[10px] text-neutral-500 leading-tight">
          Recurring stock comp paid each year. Grows at the same real-raise rate as base salary
          (compounded annually). Spread evenly across the year.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Annual base stock" value={I.annualStockBase} onChange={(v) => patch({ annualStockBase: v })} hint="real $/yr" />
          <NumField label="Annual bonus stock" value={I.annualStockBonus} onChange={(v) => patch({ annualStockBonus: v })} hint="real $/yr" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-neutral-800 pt-3">
        <NumField label="Haircut" value={I.haircut} onChange={(v) => patch({ haircut: v })} step={0.01} hint="applies to both" />
      </div>
    </div>
  );
}

// ===================== Children editor =====================

function ChildrenEditor({
  children, setChildren, planStart,
}: { children: Child[]; setChildren: (c: Child[]) => void; planStart: string }) {
  const add = () => {
    const id = "c" + Math.random().toString(36).slice(2, 8);
    setChildren([...children, { id, name: `Child ${children.length + 1}`, birthYear: 3, amount529: 95000, monthlyCost: 1000 }]);
  };
  const update = (id: string, patch: Partial<Child>) =>
    setChildren(children.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => setChildren(children.filter((c) => c.id !== id));

  return (
    <div className="space-y-2">
      {children.map((c) => (
        <div key={c.id} className="border border-neutral-800 rounded p-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text" value={c.name}
              onChange={(e) => update(c.id, { name: e.target.value })}
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs"
            />
            <button onClick={() => remove(c.id)} className="text-xs text-neutral-500 hover:text-rose-400">Remove</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <DateField label="Birth date" valueYears={c.birthYear} onChange={(v) => update(c.id, { birthYear: v })} planStart={planStart} allowNone />
            <NumField
              label="Monthly $"
              value={c.monthlyCost ?? 0}
              onChange={(v) => update(c.id, { monthlyCost: v })}
              hint="raising cost / mo"
            />
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-neutral-400">529 contribution</span>
              <select
                value={c.contribMode529 ?? "lump"}
                onChange={(e) => update(c.id, { contribMode529: e.target.value as "lump" | "monthly" | "auto" })}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
              >
                <option value="lump">Lump sum at birth</option>
                <option value="monthly">Monthly until age</option>
                <option value="auto">Auto-fund to tuition</option>
              </select>
            </label>
            {(c.contribMode529 ?? "lump") !== "auto" && (
              <NumField
                label={(c.contribMode529 ?? "lump") === "monthly" ? "Monthly $" : "Lump sum $"}
                value={c.amount529}
                onChange={(v) => update(c.id, { amount529: v })}
                hint={(c.contribMode529 ?? "lump") === "monthly" ? "per month per kid" : "superfunded at birth"}
              />
            )}
            {(c.contribMode529 ?? "lump") === "auto" && (c.collegeAnnualCost ?? 0) === 0 && (
              <div className="text-[10px] text-amber-300 col-span-2">
                Auto mode needs a non-zero <strong>Yearly college tuition</strong> to size against.
              </div>
            )}
            {(c.contribMode529 ?? "lump") === "monthly" && (
              <NumField label="Until age" value={c.contribUntilYears ?? 18} onChange={(v) => update(c.id, { contribUntilYears: v })} hint="stop contrib" />
            )}
            <NumField
              label="Yearly college tuition"
              value={c.collegeAnnualCost ?? 0}
              onChange={(v) => update(c.id, { collegeAnnualCost: v })}
              hint="0 = no college; draws 529 then brokerage"
            />
            {(c.collegeAnnualCost ?? 0) > 0 && (
              <>
                <NumField
                  label="Start age"
                  value={c.collegeStartAge ?? 18}
                  onChange={(v) => update(c.id, { collegeStartAge: v })}
                />
                <NumField
                  label="Duration (yrs)"
                  value={c.collegeDurationYears ?? 4}
                  onChange={(v) => update(c.id, { collegeDurationYears: v })}
                />
              </>
            )}
          </div>
        </div>
      ))}
      <button onClick={add} className="text-xs w-full py-1 border border-dashed border-neutral-700 rounded hover:bg-neutral-800">
        + Add child
      </button>
    </div>
  );
}

// ===================== Expenses importer =====================
// Pulls last 12 months of category spend from /api/stats and lets the user
// classify each category into housing / inelastic / discretionary / ignore.
// Then applies the medians as starting expense values.

type ExpenseBucket = "rent" | "inelastic" | "discretionary" | "medical" | "ignore";

// Fetch 12-month medians from /api/stats and group by category. Pure data —
// used by both the auto-import-on-load effect and the manual importer UI.
async function fetchCategoryMedians(): Promise<{ category: string; med: number; bucket: ExpenseBucket }[]> {
  const month = new Date().toISOString().slice(0, 7);
  const r = await fetch(`/api/stats?before=0&after=0&month=${month}`);
  if (!r.ok) throw new Error("API " + r.status);
  const j = await r.json();
  const monthly: { category: string; month: string; total: number }[] = j.categoryMonthly ?? [];
  const byCat = new Map<string, number[]>();
  for (const m of monthly) {
    if (!byCat.has(m.category)) byCat.set(m.category, []);
    byCat.get(m.category)!.push(m.total);
  }
  const out: { category: string; med: number; bucket: ExpenseBucket }[] = [];
  for (const [category, values] of byCat) {
    const med = median(values);
    if (med <= 0) continue;
    out.push({ category, med, bucket: classifyCategory(category) });
  }
  out.sort((a, b) => b.med - a.med);
  return out;
}

function classifyCategory(name: string): ExpenseBucket {
  const n = name.toLowerCase();
  if (/\brent\b|\bmortgage\b|\bhoa\b|housing/.test(n)) return "rent";
  // Medical: only the standalone Medical / Healthcare category (single bucket),
  // not insurance premiums or anything broader. User can override individual
  // rows in the per-category editor if their naming differs.
  if (n === "medical" || n === "healthcare" || n === "medical & healthcare") return "medical";
  if (
    /util|insurance|internet|phone|subscription|electric|water|sewer|trash|cable|cell|stream|tax|debt|loan|tuition|childcare|dues|membership|gym|fitness|interest|service/
      .test(n)
  ) return "inelastic";
  // Everything else defaults to discretionary — categories shouldn't silently
  // disappear from the import; the user can re-bucket or ignore in the UI.
  return "discretionary";
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ExpensesImporter({
  onApply,
}: { onApply: (v: { rent: number; inelastic: number; discretionary: number; medical: number; categoryOverrides: CategoryRow[] }) => void }) {
  const [rows, setRows] = useState<{ category: string; med: number; bucket: ExpenseBucket }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const result = await fetchCategoryMedians();
      setRows(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  const apply = () => {
    if (!rows) return;
    let rent = 0, inelastic = 0, discretionary = 0, medical = 0;
    const overrides: CategoryRow[] = [];
    for (const r of rows) {
      if (r.bucket === "ignore") continue;
      const monthly = Math.round(r.med);
      overrides.push({ category: r.category, monthly, bucket: r.bucket });
      if (r.bucket === "rent") rent += monthly;
      else if (r.bucket === "inelastic") inelastic += monthly;
      else if (r.bucket === "discretionary") discretionary += monthly;
      else if (r.bucket === "medical") medical += monthly;
    }
    onApply({ rent, inelastic, discretionary, medical, categoryOverrides: overrides });
  };

  return (
    <div className="space-y-2">
      {!rows && (
        <button
          onClick={load} disabled={loading}
          className="text-xs px-2 py-1 border border-neutral-700 rounded hover:bg-neutral-800"
        >
          {loading ? "Loading..." : "Import 12-mo medians"}
        </button>
      )}
      {error && <div className="text-xs text-rose-400">{error}</div>}
      {rows && (
        <div className="space-y-1 max-h-96 overflow-y-auto">
          <div className="text-[10px] text-neutral-500">12-month median per category. Assign each to a bucket, then Apply.</div>
          {rows.map((r, i) => (
            <div key={r.category} className="flex items-center gap-2 text-xs">
              <div className="flex-1 truncate text-neutral-300">{r.category}</div>
              <div className="text-neutral-400 w-16 text-right">{fmt(r.med)}</div>
              <select
                value={r.bucket}
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = { ...r, bucket: e.target.value as ExpenseBucket };
                  setRows(next);
                }}
                className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs"
              >
                <option value="rent">housing</option>
                <option value="medical">medical (HSA)</option>
                <option value="inelastic">inelastic</option>
                <option value="discretionary">discretionary</option>
                <option value="ignore">ignore</option>
              </select>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={apply} className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded">Apply</button>
            <button onClick={() => setRows(null)} className="text-xs px-2 py-1 border border-neutral-700 rounded hover:bg-neutral-800">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================== Per-category overrides editor =====================
// Per-scenario tweak of individual expense categories. Lump fields above
// (rent/inelastic/discretionary) are overridden by the sums here when any
// rows exist.

function CategoryOverridesEditor({
  rows, setRows,
}: { rows: CategoryRow[]; setRows: (r: CategoryRow[]) => void }) {
  const update = (idx: number, patch: Partial<CategoryRow>) => {
    const next = [...rows];
    next[idx] = { ...next[idx], ...patch };
    setRows(next);
  };
  const remove = (idx: number) => setRows(rows.filter((_, i) => i !== idx));
  const add = () => setRows([...rows, { category: "New category", monthly: 0, bucket: "discretionary" }]);

  // Group totals
  const sums = { rent: 0, inelastic: 0, discretionary: 0, medical: 0 };
  for (const r of rows) sums[r.bucket] += r.monthly;

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-neutral-500">
        These override the rent / inelastic / discretionary lumps above when populated.
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-neutral-500 italic">
          No category overrides. Use the importer to populate from your transactions.
        </div>
      ) : (
        <>
          <div className="max-h-80 overflow-y-auto space-y-1">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1 text-xs">
                <input
                  type="text" value={r.category}
                  onChange={(e) => update(i, { category: e.target.value })}
                  className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5"
                />
                <input
                  type="number" step="any" value={r.monthly}
                  onChange={(e) => update(i, { monthly: parseFloat(e.target.value) || 0 })}
                  className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5 text-right"
                />
                <select
                  value={r.bucket}
                  onChange={(e) => update(i, { bucket: e.target.value as ExpenseBucketTag })}
                  className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
                >
                  <option value="rent">housing</option>
                  <option value="medical">medical</option>
                  <option value="inelastic">inelastic</option>
                  <option value="discretionary">discretion</option>
                </select>
                <button onClick={() => remove(i)} className="text-neutral-500 hover:text-rose-400 px-1">✕</button>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-neutral-400 border-t border-neutral-800 pt-2">
            <span className="text-neutral-300 font-medium">Totals:</span>{" "}
            housing {fmt(sums.rent)} · medical {fmt(sums.medical)} · inelastic {fmt(sums.inelastic)} · discretionary {fmt(sums.discretionary)}
          </div>
        </>
      )}
      <div className="flex gap-2">
        <button onClick={add} className="text-xs px-2 py-0.5 border border-dashed border-neutral-700 rounded hover:bg-neutral-800">
          + Add row
        </button>
        {rows.length > 0 && (
          <button
            onClick={() => { if (confirm("Clear all overrides?")) setRows([]); }}
            className="text-xs px-2 py-0.5 text-neutral-500 hover:text-rose-400"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

// ===================== Goals editor =====================

// `home_purchase` is intentionally NOT in this list — it lives in the House
// fund section as a first-class field, not a generic life goal.
const GOAL_KINDS: { value: GoalKind; label: string; recurring: boolean; hint: string }[] = [
  { value: "kid_yearly", label: "Kid expenses (yearly)", recurring: true, hint: "annual cost while raising a child" },
  { value: "college", label: "College (yearly)", recurring: true, hint: "draws from 529, then brokerage" },
  { value: "car", label: "Car purchase", recurring: false, hint: "one-time, from brokerage" },
  { value: "other", label: "Other big expense", recurring: false, hint: "from brokerage" },
];

function GoalsEditor({ goals, setGoals, planStart }: { goals: Goal[]; setGoals: (g: Goal[]) => void; planStart: string }) {
  const add = () => {
    const id = "g" + Math.random().toString(36).slice(2, 8);
    setGoals([...goals, { id, kind: "other", name: "New goal", startYear: 5, amount: 50000 }]);
  };
  const update = (id: string, patch: Partial<Goal>) =>
    setGoals(goals.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const remove = (id: string) => setGoals(goals.filter((g) => g.id !== id));

  return (
    <div className="space-y-2">
      {goals.map((g) => {
        const kindMeta = GOAL_KINDS.find((k) => k.value === g.kind)!;
        return (
          <div key={g.id} className="border border-neutral-800 rounded p-2 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text" value={g.name}
                onChange={(e) => update(g.id, { name: e.target.value })}
                className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs"
              />
              <button onClick={() => remove(g.id)} className="text-xs text-neutral-500 hover:text-rose-400">Remove</button>
            </div>
            <select
              value={g.kind}
              onChange={(e) => {
                const newKind = e.target.value as GoalKind;
                const meta = GOAL_KINDS.find((k) => k.value === newKind)!;
                update(g.id, {
                  kind: newKind,
                  endYear: meta.recurring ? (g.endYear ?? g.startYear + 18) : undefined,
                });
              }}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs"
            >
              {GOAL_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <DateField label="Start" valueYears={g.startYear} onChange={(v) => update(g.id, { startYear: v })} planStart={planStart} />
              {kindMeta.recurring && (
                <DateField label="End" valueYears={g.endYear ?? g.startYear + 18} onChange={(v) => update(g.id, { endYear: v })} planStart={planStart} hint="inclusive" />
              )}
              <NumField
                label={kindMeta.recurring ? "Annual amount" : "Total amount"}
                value={g.amount}
                onChange={(v) => update(g.id, { amount: v })}
                hint={g.autoRemainder ? "ignored (auto)" : undefined}
              />
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={g.autoRemainder ?? false}
                onChange={(e) => update(g.id, { autoRemainder: e.target.checked })}
                className="accent-blue-500"
              />
              <span className="text-neutral-300">Auto-size from remaining capacity</span>
            </label>
            {(g.kind === "car" || g.kind === "other") && (
              <NumField
                label="Ongoing $/mo"
                value={g.ownershipMonthly ?? 0}
                onChange={(v) => update(g.id, { ownershipMonthly: v })}
                hint={g.kind === "car" ? "insurance + gas + maint ≈ $400/mo" : "recurring after purchase"}
              />
            )}
            <div className="text-[10px] text-neutral-500">{kindMeta.hint}</div>
          </div>
        );
      })}
      <button onClick={add} className="text-xs w-full py-1 border border-dashed border-neutral-700 rounded hover:bg-neutral-800">
        + Add goal
      </button>
    </div>
  );
}

// ===================== Fidelity import =====================

interface FidelityAccount { account_id: string; name: string; balance: number }

type FidBucket = "401k" | "hsa" | "529" | "brokerage" | "other";

function classifyFidelity(name: string): FidBucket {
  const n = name.toLowerCase();
  if (n.includes("401")) return "401k";
  if (n.includes("hsa")) return "hsa";
  if (n.includes("529")) return "529";
  if (n.includes("ira")) return "other";
  return "brokerage";
}

function FidelityImporter({
  onApply,
}: { onApply: (vals: { bal401k?: number; balHsa?: number; bal529?: number; balBrokerage?: number }) => void }) {
  const [accounts, setAccounts] = useState<FidelityAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, FidBucket>>({});

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const month = new Date().toISOString().slice(0, 7);
      const r = await fetch(`/api/stats?before=0&after=0&month=${month}`);
      if (!r.ok) throw new Error("API " + r.status);
      const j = await r.json();
      const acc: FidelityAccount[] = j.investmentAccounts ?? [];
      setAccounts(acc);
      const init: Record<string, FidBucket> = {};
      for (const a of acc) init[a.account_id] = classifyFidelity(a.name);
      setOverrides(init);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  const apply = () => {
    if (!accounts) return;
    const totals = { bal401k: 0, balHsa: 0, bal529: 0, balBrokerage: 0 };
    for (const a of accounts) {
      const c = overrides[a.account_id];
      if (c === "401k") totals.bal401k += a.balance;
      else if (c === "hsa") totals.balHsa += a.balance;
      else if (c === "529") totals.bal529 += a.balance;
      else if (c === "brokerage") totals.balBrokerage += a.balance;
    }
    onApply(totals);
  };

  return (
    <div className="space-y-2">
      {!accounts && (
        <button
          onClick={load} disabled={loading}
          className="text-xs px-2 py-1 border border-neutral-700 rounded hover:bg-neutral-800"
        >
          {loading ? "Loading..." : "Import from Fidelity"}
        </button>
      )}
      {error && <div className="text-xs text-rose-400">{error}</div>}
      {accounts && (
        <div className="space-y-1">
          <div className="text-[10px] text-neutral-500">Choose a bucket for each Fidelity account, then apply.</div>
          {accounts.length === 0 && <div className="text-xs text-neutral-500">No Fidelity accounts linked.</div>}
          {accounts.map((a) => (
            <div key={a.account_id} className="flex items-center gap-2 text-xs">
              <div className="flex-1 truncate text-neutral-300">{a.name}</div>
              <div className="text-neutral-400 w-20 text-right">{fmt(a.balance)}</div>
              <select
                value={overrides[a.account_id]}
                onChange={(e) => setOverrides({ ...overrides, [a.account_id]: e.target.value as FidBucket })}
                className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs"
              >
                <option value="401k">401k</option>
                <option value="hsa">HSA</option>
                <option value="529">529</option>
                <option value="brokerage">brokerage</option>
                <option value="other">skip</option>
              </select>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={apply} className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded">Apply</button>
            <button onClick={() => setAccounts(null)} className="text-xs px-2 py-1 border border-neutral-700 rounded hover:bg-neutral-800">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================== Info modal — all formulas =====================

function InfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[760px] max-w-[95vw] max-h-[90vh] overflow-y-auto bg-neutral-950 border border-neutral-800 rounded-xl p-6 space-y-4 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">How the model works</h2>
          <button onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">Close</button>
        </div>
        <div className="space-y-4 text-neutral-300">
          <p className="text-neutral-400">
            All amounts are in <strong>real (today&apos;s) dollars</strong>. Tax brackets, IRS limits, standard
            deductions, SS wage cap, and personal exemptions stay flat in real terms (they&apos;re inflation-indexed
            nominally). Returns and growth rates are also real (above inflation).
          </p>

          <Subsection title="Time step">
            Monthly iteration. <code>t</code> is the month index (1 = Jan year 1). Year resets happen when{" "}
            <code>(t − 1) mod 12 = 0</code>.
          </Subsection>

          <Subsection title="Gross income">
            <Eq>I_gross(t) = I_base(t) + I_bonus(t) + I_side(t) + I_RSU(t) + I_ESPP_discount(t)</Eq>
            <ul className="list-disc list-inside text-neutral-400 space-y-1 mt-2">
              <li><strong>Base / bonus / side</strong> grow each Jan by <code>(1 + salaryGrowth)</code> in real terms.</li>
              <li><strong>Bonus</strong> pays once a year in <code>bonusMonth</code>.</li>
              <li>
                <strong>RSU vest value</strong> = (totalUnvested / totalVests) × (1 + r_market)^(t−1) × (1 − haircut),
                applied at scheduled vest months only.
              </li>
              <li>
                <strong>ESPP discount</strong> assumes sell-immediately:
                purchaseValue = baseMonthly × esppRate / (1 − discount), capped by the §423 annual cap;{" "}
                discountIncome = purchaseValue × discount. Only the discount is taxed; the contribution itself is a wash.
              </li>
              <li>All W-2 income (base/bonus/side/RSU/ESPP) goes to 0 from the retirement month onward.</li>
            </ul>
          </Subsection>

          <Subsection title="Pre-tax savings">
            <Eq>pmt401k(t) = min(target, IRSLimit − YTD401k)</Eq>
            <p className="text-neutral-400 mt-1">
              Target = either limit/12 (max mode) or <code>baseMonthly × pct401k</code>. Stops contributing once the YTD limit is hit.
              Employer match = <code>pmt401k × employerMatchRate</code>; doesn&apos;t count against §402(g); credited to the 401k balance.
            </p>
            <p className="text-neutral-400 mt-1">
              HSA: employee + employer share the same annual cap; employee monthly = hsaAnnual/12; employer monthly = hsaEmployerAnnual/12; both stop at the limit.
            </p>
          </Subsection>

          <Subsection title="FICA">
            <Eq>ssBase = min(I_gross − pmtHSA, ssWageCap − YTDss)</Eq>
            <Eq>taxSS = 0.062 × ssBase</Eq>
            <Eq>taxMed = 0.0145 × (I_gross − pmtHSA) + 0.009 × max(0, YTDgross_excl_HSA − 200000)</Eq>
            <p className="text-neutral-400 mt-1">
              HSA (via §125 cafeteria plan) is excluded from FICA wages. 401(k) is NOT excluded.
            </p>
          </Subsection>

          <Subsection title="Federal income tax">
            <Eq>fedTaxable_annual = max(0, (I_gross − pmt401k − pmtHSA) × 12 − fedStdDeduction)</Eq>
            <Eq>taxFed(t) = Brackets(fedTaxable_annual) / 12</Eq>
            <p className="text-neutral-400 mt-1">
              2025 brackets, Single or MFJ. Annualize the month, apply progressive brackets, divide by 12.
              This approximates real withholding behavior reasonably well.
            </p>
          </Subsection>

          <Subsection title="Massachusetts tax">
            <Eq>maTaxable_annual = max(0, (I_gross − pmt401k) × 12 − maPersonalExemption)</Eq>
            <Eq>taxMA(t) = 0.05 × maTaxable_annual / 12 + 0.04 × max(0, min(monthlyMA, YTDma − 1M))</Eq>
            <p className="text-neutral-400 mt-1">
              MA conforms to federal 401(k) pre-tax treatment but <strong>NOT</strong> to HSA — HSA contributions are still taxed by MA.
              Millionaire surtax kicks in once YTD taxable income exceeds $1M.
            </p>
          </Subsection>

          <Subsection title="Net pay & FCF">
            <Eq>I_net = I_gross − pmt401k − pmtHSA − taxTotal</Eq>
            <Eq>expenses = housing(t) + inelastic × (1 + ineGrowth)^y + discretionary × (1 + discGrowth)^y + activeKids × costPerKidMonthly</Eq>
            <Eq>FCF = I_net − expenses</Eq>
            <p className="text-neutral-400 mt-1">
              Housing = rentMonthly until the first home_purchase goal fires, then auto-computed mortgage P&amp;I (amortized over mortgageTermYears at mortgageRate).
              Active kids = born and within <code>kidYears</code> of birth (default 18).
            </p>
          </Subsection>

          <Subsection title="Waterfall (positive FCF)">
            <ol className="list-decimal list-inside text-neutral-400 space-y-1 mt-1">
              <li>Emergency fund → fill to <code>emergencyMonths × current_expenses</code></li>
              <li>529 birth lump → fires only in a child&apos;s birth month</li>
              <li>House fund → fill to <code>houseTargetValue × (downPct + closingPct)</code></li>
              <li>Brokerage absorbs the rest</li>
            </ol>
            <p className="text-neutral-400 mt-2">
              Negative FCF (typically post-retirement): drawn from brokerage as a negative payment.
            </p>
          </Subsection>

          <Subsection title="Goal withdrawals">
            <p className="text-neutral-400 mt-1">
              Each goal draws from a kind-specific bucket first, then brokerage:
              home_purchase → house fund → brokerage; college → 529 → brokerage; everything else → brokerage.
              Recurring goals (annual amount × duration months/12) split evenly across the month range.
              Shortfalls are recorded if even brokerage can&apos;t cover the draw.
              <code>autoRemainder</code> goals get sized at runtime to the full available balance.
            </p>
          </Subsection>

          <Subsection title="Compounding">
            Monthly compounding using <code>r_monthly = (1 + r_annual)^(1/12) − 1</code>. Market accounts
            (401k, HSA, 529, brokerage) use the real market rate; emergency + house fund use the safe rate.
          </Subsection>

          <Subsection title="Retirement comparison (4% rule)">
            <Eq>sustainableSpend ≈ 0.04 × netWorth</Eq>
            <p className="text-neutral-400 mt-1">
              Quick proxy for &ldquo;quality of life&rdquo;: 4% of NW is the classic Trinity-study safe withdrawal rate
              for a 30-year retirement.
            </p>
          </Subsection>
        </div>
      </div>
    </div>
  );
}

function Subsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-neutral-800 pt-3">
      <h3 className="text-sm font-medium text-neutral-200 mb-1">{title}</h3>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Eq({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-xs text-neutral-200 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 my-1 overflow-x-auto">
      {children}
    </div>
  );
}


// ===================== Diff vs default scenario =====================
// Walks the top-level Inputs and surfaces fields that differ from a reference
// scenario (the first scenario in the store). Arrays are summarized by length
// and total $ where applicable.

interface DiffEntry { key: string; baseline: string; current: string }

function diffInputs(base: Inputs, cur: Inputs): DiffEntry[] {
  const out: DiffEntry[] = [];
  const fmt$ = (v: number) => "$" + Math.round(v).toLocaleString();
  const fmtPct = (v: number) => (v * 100).toFixed(2) + "%";
  const numericKeys: (keyof Inputs)[] = [
    "horizonYears", "baseSalaryAnnual", "bonusAnnual", "salaryGrowth", "sideMonthlyCash", "sideEndYear",
    "rsuTotalValue", "rsuFirstVestYear", "rsuTotalVests", "rsuVestsPerYear",
    "annualStockBase", "annualStockBonus", "haircut",
    "pct401k", "limit401k", "employerMatchRate",
    "hsaAnnual", "hsaLimit", "hsaEmployerAnnual",
    "esppRate", "esppDiscount", "esppAnnualCap",
    "rentMonthly", "mortgageRate", "mortgageTermYears", "propertyTaxRate", "homeInsuranceRate",
    "maintenanceRate", "hoaMonthly", "inelasticMonthly", "discretionaryMonthly",
    "costPerKidMonthly", "kidYears", "medicalMonthly", "emergencyMonths", "balEmergencyStart",
    "spouseSharePct", "spouseMoveInYear", "spouseRentSharePct",
    "houseTargetValue", "houseDownPaymentPct", "houseClosingCostPct",
    "rNomAnnual", "rSafeAnnual", "inflationDisplay",
    "bal401kStart", "balHsaStart", "balHouseStart", "bal529Start", "balBrokerageStart",
    "retirementYear", "retirementAnnualSpend",
  ];
  const pctKeys = new Set([
    "salaryGrowth", "haircut", "pct401k", "employerMatchRate", "esppRate", "esppDiscount",
    "houseDownPaymentPct", "houseClosingCostPct", "rNomAnnual", "rSafeAnnual", "inflationDisplay",
    "inelasticGrowth", "discretionaryGrowth", "mortgageRate",
    "spouseSharePct", "spouseRentSharePct",
  ]);
  for (const k of numericKeys) {
    const b = base[k] as number; const c = cur[k] as number;
    if (typeof b !== "number" || typeof c !== "number") continue;
    if (Math.abs(b - c) > 0.0001) {
      out.push({
        key: String(k),
        baseline: pctKeys.has(k) ? fmtPct(b) : fmt$(b),
        current: pctKeys.has(k) ? fmtPct(c) : fmt$(c),
      });
    }
  }
  if (base.filingStatus !== cur.filingStatus)
    out.push({ key: "filingStatus", baseline: base.filingStatus, current: cur.filingStatus });
  if (Boolean(base.max401kAlways) !== Boolean(cur.max401kAlways))
    out.push({ key: "max401kAlways", baseline: String(Boolean(base.max401kAlways)), current: String(Boolean(cur.max401kAlways)) });
  if ((base.children?.length ?? 0) !== (cur.children?.length ?? 0))
    out.push({ key: "children", baseline: `${base.children.length} kids`, current: `${cur.children.length} kids` });
  if ((base.goals?.length ?? 0) !== (cur.goals?.length ?? 0))
    out.push({ key: "goals", baseline: `${base.goals.length} goals`, current: `${cur.goals.length} goals` });
  return out;
}

function DiffBar({ entries, baselineName }: { entries: DiffEntry[]; baselineName: string }) {
  if (entries.length === 0) return null;
  return (
    <div className="border border-amber-900 bg-amber-950/30 rounded-lg p-3 mb-4">
      <div className="text-xs uppercase tracking-wider text-amber-300/80 mb-1.5">
        {entries.length} change{entries.length === 1 ? "" : "s"} vs &ldquo;{baselineName}&rdquo;
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {entries.slice(0, 20).map((e) => (
          <div key={e.key} className="text-amber-100">
            <span className="text-neutral-400">{e.key}: </span>
            <span className="line-through text-neutral-500">{e.baseline}</span>
            <span className="text-neutral-500"> → </span>
            <span className="font-medium">{e.current}</span>
          </div>
        ))}
        {entries.length > 20 && <span className="text-amber-300/60">+{entries.length - 20} more</span>}
      </div>
    </div>
  );
}

// ===================== Main page =====================

// Simple persistent TODO list, stored in localStorage. Used to capture open
// modeling questions / things to revisit while iterating on the plan.
const TODO_KEY = "budget-v2-planning-todos";
function TodoBox() {
  const seed = [
    { id: "inflation", text: "how do i handle inflation to make all the amounts be \"present day real money\"?" },
  ];
  const [items, setItems] = useState<{ id: string; text: string; done?: boolean }[]>(seed);
  const [hydrated, setHydrated] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TODO_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { id: string; text: string; done?: boolean }[];
        // Merge in the seed items that aren't present yet.
        const have = new Set(parsed.map((p) => p.id));
        const merged = [...parsed, ...seed.filter((s) => !have.has(s.id))];
        setItems(merged);
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(TODO_KEY, JSON.stringify(items)); } catch {}
  }, [items, hydrated]);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setItems([...items, { id: "t" + Math.random().toString(36).slice(2, 8), text }]);
    setDraft("");
  };
  const toggle = (id: string) =>
    setItems(items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));
  const remove = (id: string) => setItems(items.filter((i) => i.id !== id));

  return (
    <div className="border border-neutral-800 rounded-lg p-3 mb-4 bg-neutral-900/30">
      <div className="text-xs uppercase tracking-wider text-neutral-400 mb-2">Todo</div>
      <ul className="space-y-1 mb-2">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!it.done}
              onChange={() => toggle(it.id)}
              className="mt-0.5 accent-blue-500"
            />
            <span className={it.done ? "text-neutral-500 line-through flex-1" : "text-neutral-200 flex-1"}>{it.text}</span>
            <button onClick={() => remove(it.id)} className="text-neutral-500 hover:text-rose-400 text-[10px]">✕</button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="Add a todo..."
          className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-100"
        />
        <button onClick={add} className="text-xs px-2 py-1 border border-neutral-700 rounded hover:bg-neutral-800">
          Add
        </button>
      </div>
    </div>
  );
}

// Lightweight tab bar for the sidebar. Each tab renders only when active —
// keeps the sidebar height roughly proportional to one tab's content rather
// than the sum of every section.
function SidebarTabs({ tabs, activeKey, onChange }: {
  tabs: { key: string; label: string }[];
  activeKey: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-neutral-800 pb-2 mb-2">
      {tabs.map((t) => {
        const active = t.key === activeKey;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={
              "text-[11px] px-2.5 py-1 rounded transition-colors " +
              (active
                ? "bg-blue-600 text-white"
                : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200")
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export default function PlanningPage() {
  const [store, setStore] = useState<ScenarioStore>(() => ({
    scenarios: [{ id: "init", name: "Current plan", inputs: DEFAULTS }],
    activeId: "init",
  }));
  const [hydrated, setHydrated] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("income");

  // Hydrate: prefer server (disk) if available; fall back to localStorage so
  // existing browser-only setups don't lose their scenarios on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/planning");
        const j = (await r.json()) as { store: ScenarioStore | null };
        if (cancelled) return;
        if (j.store && Array.isArray(j.store.scenarios) && j.store.scenarios.length > 0) {
          // Re-merge through mergeInputs (backfill new fields) then re-anchor
          // every saved year-offset to the CURRENT month, so dates the user
          // set as e.g. "2034" stay at 2034 even on tomorrow's reload.
          const migrated: ScenarioStore = {
            ...j.store,
            scenarios: j.store.scenarios.map((s) => ({
              ...s,
              inputs: reanchorInputs(mergeInputs(s.inputs as Partial<Inputs>)),
            })),
          };
          setStore(migrated);
        } else {
          setStore(loadScenarioStore());
        }
      } catch {
        setStore(loadScenarioStore());
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist on every change: localStorage (instant) + debounced POST to disk.
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(SCENARIOS_KEY, JSON.stringify(store)); } catch {}
    const handle = setTimeout(() => {
      fetch("/api/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(store),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(handle);
  }, [store, hydrated]);

  // Auto-import 12-month medians for the ACTIVE scenario whenever a new
  // calendar month has rolled over since the last successful import. Keeps the
  // baseline expense data fresh. User-assigned buckets are preserved for
  // categories that still exist; new categories use the classifier default;
  // monthly $ values are refreshed from the latest medians regardless.
  useEffect(() => {
    if (!hydrated) return;
    const currentYM = todayYM();
    const activeNow = store.scenarios.find((s) => s.id === store.activeId);
    if (!activeNow) return;
    if (activeNow.inputs.categoriesImportedYM === currentYM) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchCategoryMedians();
        if (cancelled) return;
        setStore((s) => ({
          ...s,
          scenarios: s.scenarios.map((sc) => {
            if (sc.id !== s.activeId) return sc;
            // Preserve any prior bucket assignments the user has made.
            const priorByCat = new Map(sc.inputs.categoryOverrides.map((c) => [c.category, c.bucket]));
            let rent = 0, inelastic = 0, discretionary = 0, medical = 0;
            const overrides: CategoryRow[] = [];
            for (const r of rows) {
              const bucket = priorByCat.get(r.category) ?? (r.bucket === "ignore" ? "discretionary" : r.bucket);
              const monthly = Math.round(r.med);
              overrides.push({ category: r.category, monthly, bucket });
              if (bucket === "rent") rent += monthly;
              else if (bucket === "inelastic") inelastic += monthly;
              else if (bucket === "discretionary") discretionary += monthly;
              else if (bucket === "medical") medical += monthly;
            }
            return {
              ...sc,
              inputs: {
                ...sc.inputs,
                rentMonthly: rent || sc.inputs.rentMonthly,
                inelasticMonthly: inelastic || sc.inputs.inelasticMonthly,
                discretionaryMonthly: discretionary || sc.inputs.discretionaryMonthly,
                medicalMonthly: medical || sc.inputs.medicalMonthly,
                categoryOverrides: overrides.length ? overrides : sc.inputs.categoryOverrides,
                categoriesImportedYM: currentYM,
              },
            };
          }),
        }));
      } catch {
        // Mark as attempted so we don't hammer the API on every render this month.
        setStore((s) => ({
          ...s,
          scenarios: s.scenarios.map((sc) =>
            sc.id === s.activeId
              ? { ...sc, inputs: { ...sc.inputs, categoriesImportedYM: currentYM } }
              : sc
          ),
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, store.activeId, store.scenarios]);

  const active = store.scenarios.find((s) => s.id === store.activeId) ?? store.scenarios[0];
  // Re-merge with DEFAULTS on every render so newly-added Inputs fields are
  // backfilled in-memory without requiring a localStorage migration. setI
  // still writes only the user's actual edits back to the scenario.
  const I = useMemo(() => mergeInputs(active.inputs as Partial<Inputs>), [active.inputs]);
  const setI = (next: Inputs | ((prev: Inputs) => Inputs)) => {
    setStore((s) => ({
      ...s,
      scenarios: s.scenarios.map((sc) =>
        sc.id === s.activeId
          ? { ...sc, inputs: typeof next === "function" ? (next as (p: Inputs) => Inputs)(sc.inputs) : next }
          : sc
      ),
    }));
  };
  const set = <K extends keyof Inputs>(k: K) => (v: Inputs[K]) =>
    setI((prev) => ({ ...prev, [k]: v }));

  // Scenario manager actions.
  const switchScenario = (id: string) => setStore((s) => ({ ...s, activeId: id }));
  const saveAs = () => {
    const name = prompt("Name this scenario:", active.name + " copy");
    if (!name) return;
    const id = "s" + Math.random().toString(36).slice(2, 8);
    setStore((s) => ({
      scenarios: [...s.scenarios, { id, name, inputs: JSON.parse(JSON.stringify(active.inputs)) }],
      activeId: id,
    }));
  };
  const renameActive = () => {
    const name = prompt("Rename scenario:", active.name);
    if (!name) return;
    setStore((s) => ({
      ...s,
      scenarios: s.scenarios.map((sc) => (sc.id === s.activeId ? { ...sc, name } : sc)),
    }));
  };
  const deleteActive = () => {
    if (store.scenarios.length <= 1) { alert("Can't delete the last scenario."); return; }
    if (!confirm(`Delete "${active.name}"?`)) return;
    setStore((s) => {
      const remaining = s.scenarios.filter((sc) => sc.id !== s.activeId);
      return { scenarios: remaining, activeId: remaining[0].id };
    });
  };

  // Horizon is always "run to age 100" with birth year hardcoded to 2000.
  const Iresolved = useMemo<Inputs>(() => {
    const planY = parseYM(I.planStartDate)?.y ?? new Date().getFullYear();
    const yearsToAge100 = Math.max(1, 100 - (planY - 2000));
    return { ...I, horizonYears: yearsToAge100 };
  }, [I]);
  const sim = useMemo(() => simulate(Iresolved), [Iresolved]);
  const rows = sim.rows;
  const goalStatuses = sim.goals;
  const brokerageDepleteYear = sim.brokerageDepleteYear;
  const cascadeYear = sim.cascadeYear;

  // If the plan depletes, solve for two single-lever fixes:
  //   (1) income scale needed (multiplier on base + bonus + side cash)
  //   (2) expense cut needed (fraction applied to housing + inelastic +
  //       discretionary + kid step-up + house price, which proportionally
  //       shrinks mortgage P&I too)
  // Each is a 1-D binary search over `simulate` — fast in practice.
  const depletionFix = useMemo(() => {
    // Show fixes when EITHER full depletion fires (hard fail) OR the cascade
    // starts dipping into the emergency-fund / 401k / HSA chain (soft fail).
    if (brokerageDepleteYear === null && cascadeYear === null) return null;

    const tryIncome = (k: number): Inputs => ({
      ...I,
      baseSalaryAnnual: I.baseSalaryAnnual * k,
      bonusAnnual: I.bonusAnnual * k,
      sideMonthlyCash: I.sideMonthlyCash * k,
    });
    const tryExpenseCut = (cut: number): Inputs => {
      const f = 1 - cut;
      return {
        ...I,
        rentMonthly: I.rentMonthly * f,
        inelasticMonthly: I.inelasticMonthly * f,
        discretionaryMonthly: I.discretionaryMonthly * f,
        costPerKidMonthly: I.costPerKidMonthly * f,
        retirementAnnualSpend: I.retirementAnnualSpend * f,
        houseTargetValue: I.houseTargetValue * f,
        categoryOverrides: I.categoryOverrides.map((c) => ({ ...c, monthly: c.monthly * f })),
      };
    };
    // Generic 1-D binary search: find smallest k or cut that makes `ok` true.
    const search = (
      build: (x: number) => Inputs,
      ok: (sim: SimResult) => boolean,
      isCut: boolean,
    ): number | null => {
      if (isCut) {
        // Search range [0, 0.99]; smaller cut = better.
        let lo = 0, hi = 0.99;
        if (!ok(simulate(build(hi)))) return null;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (ok(simulate(build(mid)))) hi = mid; else lo = mid;
        }
        return hi;
      } else {
        // Search range [1, expand until ok]; smaller mult = better.
        let lo = 1, hi = 1;
        while (!ok(simulate(build(hi)))) { hi *= 2; if (hi > 200) return null; }
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (ok(simulate(build(mid)))) hi = mid; else lo = mid;
        }
        return hi;
      }
    };

    const survivesDeplete = (s: SimResult) => s.brokerageDepleteYear === null;
    const noCascade = (s: SimResult) => s.cascadeYear === null;

    return {
      // Hard target: liquid NW never fully depletes.
      incomeMult: brokerageDepleteYear !== null
        ? search(tryIncome, survivesDeplete, false) : null,
      expenseCut: brokerageDepleteYear !== null
        ? search(tryExpenseCut, survivesDeplete, true) : null,
      // Soft target: brokerage never goes negative, so the cascade through
      // emergency / house / 529 / 401k / HSA never fires.
      incomeMultNoCascade: cascadeYear !== null
        ? search(tryIncome, noCascade, false) : null,
      expenseCutNoCascade: cascadeYear !== null
        ? search(tryExpenseCut, noCascade, true) : null,
    };
  }, [I, brokerageDepleteYear, cascadeYear]);

  const baselineScenario =
    store.scenarios.find((s) => s.id === (store.baselineId ?? store.scenarios[0]?.id)) ?? store.scenarios[0];
  const isBaseline = baselineScenario?.id === active.id;

  // For the comparison, run both projections out to a common, long horizon so
  // we can answer "at the same retirement age, what's the wealth gap" and
  // "when does the active plan reach the baseline's target net worth".
  const comparison = useMemo(() => {
    if (!baselineScenario || isBaseline) return null;
    const compareYears = Math.max(active.inputs.horizonYears, baselineScenario.inputs.horizonYears, 30);
    const aRows = simulate({ ...active.inputs, horizonYears: compareYears }).rows;
    const bRows = simulate({ ...baselineScenario.inputs, horizonYears: compareYears }).rows;
    const bHorizonMonth = Math.max(1, Math.round(baselineScenario.inputs.horizonYears * 12));
    const bTargetNW = bRows[bHorizonMonth - 1]?.netWorth ?? 0;
    const aAtBaselineHorizon = aRows[bHorizonMonth - 1]?.netWorth ?? 0;
    // Find first month where active scenario meets/exceeds baseline's retirement target NW.
    let aReachMonth: number | null = null;
    for (let i = 0; i < aRows.length; i++) {
      if (aRows[i].netWorth >= bTargetNW) { aReachMonth = i + 1; break; }
    }
    return {
      baselineName: baselineScenario.name,
      baselineHorizonYears: baselineScenario.inputs.horizonYears,
      bTargetNW,
      aAtBaselineHorizon,
      delta: aAtBaselineHorizon - bTargetNW,
      aReachMonth,
      compareYears,
    };
  }, [active.inputs, baselineScenario, isBaseline]);

  // Goals with a recurring ownership cost — each becomes its own column in
  // the annual summary table so the user can see exactly what each goal
  // contributes per year.
  const ownershipGoals = useMemo(
    () => I.goals.filter((g) => (g.ownershipMonthly ?? 0) > 0),
    [I.goals],
  );

  const yearly = useMemo(() => {
    const out: Record<number, {
      year: number;
      // Inflows
      iBase: number; iBonus: number; iSide: number; iRSU: number; iESPPdisc: number;
      empMatch: number; empHsa: number;
      gross: number;
      // Outflows
      taxFICA: number; taxFed: number; taxState: number; taxProperty: number; taxCapGains: number; taxes: number;
      pmt401k: number; pmtHsa: number;
      housingPaid: number; inelasticPaid: number; discretionaryPaid: number; kidCostPaid: number; collegePaid: number;
      medicalFromHsa: number; investmentGrowth: number;
      goalOwnership: Map<string, number>;
      expensesTotal: number;
      goalWithdrawals: number;
      goalNotes: Map<string, { total: number; bySource: Map<string, number> }>;
      // Allocations of surplus
      pmtEmergency: number; pmt529: number; pmtHouse: number; pmtBrokerage: number;
      fcf: number;
      endNetWorth: number;
    }> = {};
    for (const r of rows) {
      if (!out[r.year]) out[r.year] = {
        year: r.year,
        iBase: 0, iBonus: 0, iSide: 0, iRSU: 0, iESPPdisc: 0, empMatch: 0, empHsa: 0, gross: 0,
        taxFICA: 0, taxFed: 0, taxState: 0, taxProperty: 0, taxCapGains: 0, taxes: 0,
        pmt401k: 0, pmtHsa: 0,
        housingPaid: 0, inelasticPaid: 0, discretionaryPaid: 0, kidCostPaid: 0, collegePaid: 0,
        medicalFromHsa: 0, investmentGrowth: 0, expensesTotal: 0,
        goalOwnership: new Map<string, number>(),
        goalWithdrawals: 0,
        goalNotes: new Map<string, { total: number; bySource: Map<string, number> }>(),
        pmtEmergency: 0, pmt529: 0, pmtHouse: 0, pmtBrokerage: 0,
        fcf: 0,
        endNetWorth: 0,
      };
      const y = out[r.year];
      y.iBase += r.iBase; y.iBonus += r.iBonus; y.iSide += r.iSide; y.iRSU += r.iRSU;
      y.iESPPdisc += r.esppDiscountIncome;
      y.empMatch += r.empMatch; y.empHsa += r.hsaEmp;
      y.gross += r.iGross;
      y.taxFICA += r.taxFICA; y.taxFed += r.taxFed; y.taxState += r.taxState;
      y.taxProperty += r.taxProperty; y.taxCapGains += r.taxCapGains;
      y.taxes += r.taxTotal + r.taxProperty + r.taxCapGains;
      y.pmt401k += r.pmt401k; y.pmtHsa += r.pmtHsa;
      y.housingPaid += r.housingPaid; y.inelasticPaid += r.inelasticPaid;
      y.discretionaryPaid += r.discretionaryPaid; y.kidCostPaid += r.kidCostPaid;
      y.collegePaid += r.collegePaid;
      y.medicalFromHsa += r.medicalFromHsa;
      y.investmentGrowth += r.investmentGrowth;
      for (const ev of r.goalOwnershipByGoal) {
        y.goalOwnership.set(ev.goalId, (y.goalOwnership.get(ev.goalId) ?? 0) + ev.amount);
      }
      y.expensesTotal += r.expensesTotal;
      y.goalWithdrawals += r.goalWithdrawals;
      for (const ev of r.goalEvents) {
        const entry = y.goalNotes.get(ev.name) ?? { total: 0, bySource: new Map<string, number>() };
        entry.total += ev.amount;
        if (ev.source) {
          entry.bySource.set(ev.source, (entry.bySource.get(ev.source) ?? 0) + ev.amount);
        }
        y.goalNotes.set(ev.name, entry);
      }
      y.pmtEmergency += r.pmtEmergency; y.pmt529 += r.pmt529; y.pmtHouse += r.pmtHouse;
      y.pmtBrokerage += r.pmtBrokerage;
      y.fcf += r.fcf;
      y.endNetWorth = r.netWorth;
    }
    return Object.values(out);
  }, [rows]);

  // Chart data uses decimal years on the x-axis for readability.
  // Non-brokerage buckets are clipped at 0 (they can't go negative in our
  // model — the cascading drawdown stops at 0 for each). Brokerage is allowed
  // to go negative so the chart shows when the plan is truly underwater.
  const clip = (n: number) => Math.max(0, Math.round(n));
  const chartData = rows.map((r) => ({
    year: +((r.t - 1) / 12 + 1 / 12).toFixed(3),
    Emergency: clip(r.balEmergency),
    "401k": clip(r.bal401k),
    HSA: clip(r.balHsa),
    House: clip(r.balHouse),
    "529": clip(r.bal529),
    Brokerage: Math.round(r.balBrokerage),
  }));

  const final = rows[rows.length - 1];

  const resetActive = () => {
    if (!confirm(`Reset "${active.name}" to defaults?`)) return;
    setI(() => DEFAULTS);
  };

  // Diff vs default = first scenario in the store. Treat that as the reference.
  const defaultScenario = store.scenarios[0];
  const diffEntries =
    defaultScenario && defaultScenario.id !== active.id
      ? diffInputs(defaultScenario.inputs, I)
      : [];

  return (
    <div className="max-w-[110rem] mx-auto">
      {showInfo && <InfoModal onClose={() => setShowInfo(false)} />}

      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Long-term Planning</h1>
          <p className="text-sm text-neutral-400 mt-0.5">
            Year-by-year capital-allocation & tax projection (Massachusetts). Edits auto-save to this browser.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 text-xs border border-neutral-800 rounded-lg px-2 py-1">
            <span className="text-neutral-500">Scenario:</span>
            <select
              value={store.activeId}
              onChange={(e) => switchScenario(e.target.value)}
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            >
              {store.scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button onClick={saveAs} className="px-2 py-0.5 hover:bg-neutral-800 rounded" title="Save current inputs as a new named scenario">Save as...</button>
            <button onClick={renameActive} className="px-2 py-0.5 hover:bg-neutral-800 rounded">Rename</button>
            <button onClick={deleteActive} className="px-2 py-0.5 hover:bg-neutral-800 rounded text-rose-300" disabled={store.scenarios.length <= 1}>Delete</button>
          </div>
          <div className="flex items-center gap-1 text-xs border border-neutral-800 rounded-lg px-2 py-1">
            <span className="text-neutral-500">Compare vs:</span>
            <select
              value={baselineScenario?.id ?? ""}
              onChange={(e) => setStore((s) => ({ ...s, baselineId: e.target.value }))}
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            >
              {store.scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <button onClick={() => setShowInfo(true)} className="text-xs px-3 py-1.5 border border-neutral-700 rounded hover:bg-neutral-800" title="View all formulas and assumptions">
            ⓘ Info
          </button>
          <button onClick={resetActive} className="text-xs px-3 py-1.5 border border-neutral-700 rounded hover:bg-neutral-800 text-rose-300">
            Reset
          </button>
        </div>
      </div>

      <TodoBox />

      {diffEntries.length > 0 && defaultScenario && (
        <DiffBar entries={diffEntries} baselineName={defaultScenario.name} />
      )}

      <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-6">
        {/* ---- Inputs sidebar ---- */}
        <div className="space-y-3">

          <SidebarTabs
            activeKey={activeTab}
            onChange={setActiveTab}
            tabs={[
              { key: "income", label: "Income" },
              { key: "tax", label: "Tax-advantaged" },
              { key: "expenses", label: "Expenses" },
              { key: "family", label: "Family" },
              { key: "housing", label: "Housing" },
              { key: "retirement", label: "Retirement" },
              { key: "goals", label: "Life goals" },
              { key: "balances", label: "Returns / Balances" },
              { key: "advanced", label: "Tax constants" },
            ]}
          />

          {/* ============================ INCOME ============================ */}
          {activeTab === "income" && (
          <SidebarGroup title="Income">
            <Section title="Cash compensation">
              <NumField label="Base salary" suffix="annual" value={I.baseSalaryAnnual} onChange={set("baseSalaryAnnual")} />
              <NumField label="Bonus" suffix="annual" value={I.bonusAnnual} onChange={set("bonusAnnual")} />
              <NumField label="Bonus month" value={I.bonusMonth} onChange={set("bonusMonth")} hint="1=Jan ... 12=Dec" />
              <NumField label="Real raise /yr" value={I.salaryGrowth} onChange={set("salaryGrowth")} step={0.005} hint="above inflation" />
              <NumField label="Side monthly" value={I.sideMonthlyCash} onChange={set("sideMonthlyCash")} hint="contract" />
              <DateField label="Side end" valueYears={I.sideEndYear} onChange={set("sideEndYear")} planStart={I.planStartDate} allowNone hint="contract end" />
            </Section>
            <StockSection I={I} patch={(p) => setI((prev) => ({ ...prev, ...p }))} />
          </SidebarGroup>
          )}

          {/* ============================ PRE-TAX SAVINGS ============================ */}
          {activeTab === "tax" && (
          <SidebarGroup title="Pre-tax savings & ESPP">
            <Section title="401(k)">
              <label className="flex items-center gap-2 text-xs col-span-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={I.max401kAlways}
                  onChange={(e) => set("max401kAlways")(e.target.checked)}
                  className="accent-blue-500"
                />
                <span className="text-neutral-300">Always contribute the IRS max</span>
              </label>
              <NumField label="% of base" value={I.pct401k} onChange={set("pct401k")} step={0.01} hint={I.max401kAlways ? "ignored (maxing)" : "0.10 = 10%"} />
              <NumField label="Employer match" value={I.employerMatchRate} onChange={set("employerMatchRate")} step={0.05} hint="0.5 = 50%" />
              <NumField label="IRS limit (real $)" value={I.limit401k} onChange={set("limit401k")} hint="§402(g)" />
            </Section>
            <Section title="HSA (pre-tax fed+FICA; MA taxes)">
              <label className="flex items-center gap-2 text-xs col-span-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={I.hsaAutoSize}
                  onChange={(e) => set("hsaAutoSize")(e.target.checked)}
                  className="accent-blue-500"
                />
                <span className="text-neutral-300">Auto-size: medical × 1.10 (less employer)</span>
              </label>
              <NumField label="Employee /yr" value={I.hsaAnnual} onChange={set("hsaAnnual")} hint={I.hsaAutoSize ? "ignored (auto)" : "2025: $4,300 / $8,550"} />
              <NumField label="Employer /yr" value={I.hsaEmployerAnnual} onChange={set("hsaEmployerAnnual")} hint="counts toward limit" />
              <NumField label="IRS limit (real $)" value={I.hsaLimit} onChange={set("hsaLimit")} />
            </Section>
            <Section title="ESPP (sell-immediately)">
              <NumField label="Contribution rate" value={I.esppRate} onChange={set("esppRate")} step={0.01} hint="% of base" />
              <NumField label="Discount" value={I.esppDiscount} onChange={set("esppDiscount")} step={0.01} />
              <NumField label="Annual cap" value={I.esppAnnualCap} onChange={set("esppAnnualCap")} hint="§423: $25k" />
            </Section>
          </SidebarGroup>
          )}

          {/* ============================ EXPENSES ============================ */}
          {activeTab === "expenses" && (
          <SidebarGroup
            title="Expenses (monthly)"
            action={<ExpensesImporter onApply={(v) => setI((prev) => ({
              ...prev,
              rentMonthly: v.rent,
              inelasticMonthly: v.inelastic,
              discretionaryMonthly: v.discretionary,
              medicalMonthly: v.medical,
              categoryOverrides: v.categoryOverrides,
              categoriesImportedYM: todayYM(),
            }))} />}
          >
            <Section title="Housing">
              <NumField label="Rent (pre-purchase)" value={I.rentMonthly} onChange={set("rentMonthly")} hint="stops at home purchase" />
            </Section>
            <Section title="Other expenses">
              <NumField label="Inelastic" value={I.inelasticMonthly} onChange={set("inelasticMonthly")} hint="utilities, insurance, subs" />
              <NumField label="Inelastic real growth" value={I.inelasticGrowth} onChange={set("inelasticGrowth")} step={0.005} />
              <NumField label="Discretionary" value={I.discretionaryMonthly} onChange={set("discretionaryMonthly")} hint="food, travel, fun" />
              <NumField label="Discretionary real growth" value={I.discretionaryGrowth} onChange={set("discretionaryGrowth")} step={0.005} />
            </Section>
            <Section title="Medical step-down">
              <DateField
                label="Drop date"
                valueYears={I.medicalDropYear}
                onChange={set("medicalDropYear")}
                planStart={I.planStartDate}
                allowNone
                hint="e.g. stop therapy"
              />
              <NumField
                label="After-drop $/mo"
                value={I.medicalAfterMonthly}
                onChange={set("medicalAfterMonthly")}
                hint="new medical/mo"
              />
            </Section>
            <Section title="Children defaults">
              <NumField label="Active dependent years" value={I.kidYears} onChange={set("kidYears")} hint="18 = until 18th birthday" />
            </Section>
            <Section title="Spouse">
              <NumField
                label="Spouse % of home + kids"
                value={I.spouseSharePct}
                onChange={set("spouseSharePct")}
                step={0.05}
                hint="0 = no spouse · 0.5 = 50/50 split"
              />
              <DateField
                label="Move in (while renting)"
                valueYears={I.spouseMoveInYear}
                onChange={set("spouseMoveInYear")}
                planStart={I.planStartDate}
                allowNone
                hint="optional pre-buy roommate"
              />
              <NumField
                label="Spouse % of rent"
                value={I.spouseRentSharePct}
                onChange={set("spouseRentSharePct")}
                step={0.05}
                hint="after move-in date"
              />
              <div className="text-[10px] text-neutral-500 col-span-2 leading-tight">
                Spouse share is applied to: post-buy housing (mortgage + tax + insurance + maintenance + HOA),
                down payment, kid step-up, 529 contributions, kid_yearly + college goals.
                Pre-buy rent uses the separate move-in date + rent-share factor.
                Salary, taxes, 401k, HSA, ESPP, utilities, personal discretionary, car / other goals, and retirement
                spend are personal.
              </div>
            </Section>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">Per-category overrides</h3>
              <CategoryOverridesEditor rows={I.categoryOverrides} setRows={set("categoryOverrides")} />
            </div>
          </SidebarGroup>
          )}

          {/* ============================ FAMILY ============================ */}
          {activeTab === "family" && (
          <SidebarGroup title="Marriage, spouse, & children">
            <Section title="Marriage">
              <DateField
                label="Marriage date"
                valueYears={I.marriageYear}
                onChange={set("marriageYear")}
                planStart={I.planStartDate}
                allowNone
                hint="filing flips to MFJ"
              />
              <NumField label="Spouse base /yr" value={I.spouseBaseAnnual} onChange={set("spouseBaseAnnual")} />
              <NumField label="Spouse bonus /yr" value={I.spouseBonusAnnual} onChange={set("spouseBonusAnnual")} />
              <NumField label="Spouse bonus month" value={I.spouseBonusMonth} onChange={set("spouseBonusMonth")} hint="1=Jan ... 12=Dec" />
              <NumField label="Spouse real raise" value={I.spouseSalaryGrowth} onChange={set("spouseSalaryGrowth")} step={0.005} hint="above inflation" />
              <div className="text-[10px] text-neutral-500 col-span-2 leading-tight">
                On the marriage month, filing status flips to MFJ — uses MFJ brackets, std deduction,
                MA exemption, and Medicare-surtax / CTC phase-out thresholds. Spouse income is added to
                gross from that month forward.
              </div>
            </Section>
            <Section title="Spouse cost-sharing">
              <NumField
                label="Spouse % of home + kids"
                value={I.spouseSharePct}
                onChange={set("spouseSharePct")}
                step={0.05}
                hint="0 = no share · 0.5 = 50/50"
              />
              <DateField
                label="Move in (while renting)"
                valueYears={I.spouseMoveInYear}
                onChange={set("spouseMoveInYear")}
                planStart={I.planStartDate}
                allowNone
                hint="optional pre-buy roommate"
              />
              <NumField
                label="Spouse % of rent"
                value={I.spouseRentSharePct}
                onChange={set("spouseRentSharePct")}
                step={0.05}
                hint="after move-in date"
              />
              <NumField
                label="Spouse % of college"
                value={I.spouseCollegeSharePct}
                onChange={set("spouseCollegeSharePct")}
                step={0.05}
                hint="tuition split (separate)"
              />
            </Section>
            <Section title="Children defaults">
              <NumField label="Active dependent years" value={I.kidYears} onChange={set("kidYears")} hint="18 = until 18th birthday" />
            </Section>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">Children</h3>
              <ChildrenEditor children={I.children} setChildren={set("children")} planStart={I.planStartDate} />
            </div>
          </SidebarGroup>
          )}

          {/* ============================ SAVINGS BUCKETS ============================ */}
          {activeTab === "housing" && (
          <SidebarGroup title="Savings buckets (waterfall order)">
            <Section title="1) Emergency fund">
              <NumField label="Months of expenses" value={I.emergencyMonths} onChange={set("emergencyMonths")} hint="N × current spend" />
              <NumField label="Starting balance" value={I.balEmergencyStart} onChange={set("balEmergencyStart")} />
            </Section>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">2) Children / 529 lumps</h3>
              <p className="text-[10px] text-neutral-500">Each child triggers a 529 lump sum at their birth month.</p>
              <ChildrenEditor children={I.children} setChildren={set("children")} planStart={I.planStartDate} />
            </div>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">3) House fund</h3>
              <div className="grid grid-cols-2 gap-2">
                <NumField label="Target house price" value={I.houseTargetValue} onChange={set("houseTargetValue")} hint="purchase price" />
                <DateField
                  label="Purchase date"
                  valueYears={I.homePurchaseYear}
                  onChange={(y) => set("homePurchaseYear")(y === 0 ? 0 : Math.max(y, 1 / 12))}
                  planStart={I.planStartDate}
                  allowNone
                  hint="rent→mortgage + cash drawn"
                />
                <NumField label="Down payment %" value={I.houseDownPaymentPct} onChange={set("houseDownPaymentPct")} step={0.01} hint="0.20 = no PMI" />
                <NumField label="Closing cost %" value={I.houseClosingCostPct} onChange={set("houseClosingCostPct")} step={0.005} hint="~2–5%" />
                <NumField label="Mortgage rate (real)" value={I.mortgageRate} onChange={set("mortgageRate")} step={0.0025} hint="≈0.045 real" />
                <NumField label="Mortgage term (yrs)" value={I.mortgageTermYears} onChange={set("mortgageTermYears")} hint="30 standard" />
                <NumField label="Property tax rate" value={I.propertyTaxRate} onChange={set("propertyTaxRate")} step={0.001} hint="MA avg ≈ 0.012" />
                <NumField label="Insurance rate" value={I.homeInsuranceRate} onChange={set("homeInsuranceRate")} step={0.001} hint="≈ 0.004" />
                <NumField label="Maintenance rate" value={I.maintenanceRate} onChange={set("maintenanceRate")} step={0.0025} hint="1% rule" />
                <NumField label="HOA $/mo" value={I.hoaMonthly} onChange={set("hoaMonthly")} hint="0 if SFH" />
              </div>
              <div className="text-[10px] text-neutral-500 space-y-0.5">
                <div>
                  Cash target: <strong className="text-neutral-300">{fmt(houseCashTarget(I))}</strong>
                  {(() => {
                    if (I.homePurchaseYear <= 0) {
                      return <span className="ml-1 text-neutral-500"> · set a purchase date for NW % comparison</span>;
                    }
                    const purchaseMonth = Math.max(1, Math.round(I.homePurchaseYear * 12));
                    const row = rows[Math.min(rows.length, purchaseMonth) - 1];
                    if (!row || row.netWorth <= 0) return null;
                    const pct = houseCashTarget(I) / row.netWorth;
                    const tone = pct < 0.15 ? "text-emerald-300" : pct < 0.30 ? "text-neutral-300" : pct < 0.45 ? "text-amber-300" : "text-rose-300";
                    return (
                      <span className={"ml-1 " + tone}>
                        · {(pct * 100).toFixed(0)}% of projected NW at purchase ({yearOffsetToYM(I.homePurchaseYear, I.planStartDate)})
                      </span>
                    );
                  })()}
                </div>
                <div>
                  Mortgage P&amp;I: <strong className="text-neutral-300">{fmt(mortgagePayment(I))}</strong>/mo
                  <span className="text-neutral-600"> (financed {fmt(I.houseTargetValue * (1 - I.houseDownPaymentPct))} at {(I.mortgageRate * 100).toFixed(2)}% real over {I.mortgageTermYears}y)</span>
                </div>
                <div>
                  Carrying costs: <strong className="text-neutral-300">{fmt(ownerCarryingMonthly(I))}</strong>/mo
                  <span className="text-neutral-600"> ({fmt(I.houseTargetValue * I.propertyTaxRate / 12)} tax + {fmt(I.houseTargetValue * I.homeInsuranceRate / 12)} ins + {fmt(I.houseTargetValue * I.maintenanceRate / 12)} maint{I.hoaMonthly > 0 ? ` + ${fmt(I.hoaMonthly)} HOA` : ""})</span>
                </div>
                <div className="text-neutral-300">
                  Total housing post-purchase: <strong>{fmt(mortgagePayment(I) + ownerCarryingMonthly(I))}</strong>/mo
                </div>
              </div>
            </div>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">Additional homes (3rd, 4th, …)</h3>
              <p className="text-[10px] text-neutral-500 leading-tight">
                Chain extra moves after the second home. Each one sells the previous home (net of selling costs +
                remaining mortgage) and buys the new one. Processed in chronological order.
              </p>
              <div className="space-y-2">
                {(I.additionalHomes ?? []).map((h, idx) => (
                  <div key={h.id} className="border border-neutral-800 rounded p-2 grid grid-cols-2 gap-2">
                    <DateField
                      label={`Home #${idx + 3} date`}
                      valueYears={h.year}
                      onChange={(y) => {
                        const next = [...I.additionalHomes];
                        next[idx] = { ...h, year: y };
                        set("additionalHomes")(next);
                      }}
                      planStart={I.planStartDate}
                      allowNone
                    />
                    <NumField
                      label={`Home #${idx + 3} price`}
                      value={h.value}
                      onChange={(v) => {
                        const next = [...I.additionalHomes];
                        next[idx] = { ...h, value: v };
                        set("additionalHomes")(next);
                      }}
                    />
                    <button
                      onClick={() => set("additionalHomes")(I.additionalHomes.filter((_, i) => i !== idx))}
                      className="col-span-2 text-[10px] text-neutral-500 hover:text-rose-400"
                    >
                      Remove home #{idx + 3}
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => set("additionalHomes")([
                  ...(I.additionalHomes ?? []),
                  { id: "h" + Math.random().toString(36).slice(2, 8), year: 0, value: 0 },
                ])}
                className="text-xs w-full py-1 border border-dashed border-neutral-700 rounded hover:bg-neutral-800"
              >
                + Add home transition
              </button>
            </div>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">Second home (optional)</h3>
              <p className="text-[10px] text-neutral-500 leading-tight">
                On the move date, the first home is sold (net of {(I.sellingClosingCostPct * 100).toFixed(0)}% selling costs +
                remaining mortgage), proceeds go into the house fund, then a new home is bought. P&amp;I and carrying costs
                switch to the new home value from that month onward. Real $ assumed flat.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <DateField
                  label="Move date"
                  valueYears={I.secondHomeYear}
                  onChange={set("secondHomeYear")}
                  planStart={I.planStartDate}
                  allowNone
                  hint="0 = no move"
                />
                <NumField
                  label="Second home price"
                  value={I.secondHomeValue}
                  onChange={set("secondHomeValue")}
                  hint="real $; flat over time"
                />
                <NumField
                  label="Selling closing cost %"
                  value={I.sellingClosingCostPct}
                  onChange={set("sellingClosingCostPct")}
                  step={0.005}
                  hint="commission + fees ≈ 7%"
                />
              </div>
              {I.secondHomeYear > 0 && I.secondHomeValue > 0 && I.homePurchaseYear > 0 && (() => {
                const monthsOwned = Math.max(0, Math.round((I.secondHomeYear - I.homePurchaseYear) * 12));
                const remaining = mortgageBalance(I.houseTargetValue, I.houseDownPaymentPct, I.mortgageRate, I.mortgageTermYears, monthsOwned);
                const fees = I.houseTargetValue * I.sellingClosingCostPct;
                const net = Math.max(0, I.houseTargetValue - fees - remaining);
                const newCash = I.secondHomeValue * (I.houseDownPaymentPct + I.houseClosingCostPct);
                const gap = newCash - net;
                return (
                  <div className="text-[10px] text-neutral-500 space-y-0.5">
                    <div>Remaining mortgage at move: <strong className="text-neutral-300">{fmt(remaining)}</strong></div>
                    <div>Selling fees: <strong className="text-neutral-300">{fmt(fees)}</strong></div>
                    <div>Net proceeds from sale: <strong className="text-neutral-300">{fmt(net)}</strong></div>
                    <div>Cash needed for new home: <strong className="text-neutral-300">{fmt(newCash)}</strong></div>
                    <div className={gap > 0 ? "text-amber-300" : "text-emerald-300"}>
                      {gap > 0
                        ? <>Shortfall (from brokerage): <strong>{fmt(gap)}</strong></>
                        : <>Surplus into house fund: <strong>{fmt(-gap)}</strong></>}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="text-[10px] text-neutral-500 italic px-1">
              4) Brokerage absorbs everything that&apos;s left.
            </div>
          </SidebarGroup>
          )}

          {/* ============================ RETIREMENT & GOALS ============================ */}
          {activeTab === "retirement" && (
          <SidebarGroup title="Retirement">
            <Section title="Retirement">
              <DateField label="Retirement date" valueYears={I.retirementYear} onChange={set("retirementYear")} planStart={I.planStartDate} allowNone />
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-neutral-400">Post-ret expenses</span>
                <select
                  value={I.retirementExpenseMode}
                  onChange={(e) => set("retirementExpenseMode")(e.target.value as "snapshot" | "manual")}
                  className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
                >
                  <option value="snapshot">Freeze at last pre-ret month</option>
                  <option value="manual">Hard-coded value</option>
                </select>
              </label>
              {I.retirementExpenseMode === "manual" && (
                <NumField label="Retirement spend /yr" value={I.retirementAnnualSpend} onChange={set("retirementAnnualSpend")} hint="flat real $" />
              )}
            </Section>
          </SidebarGroup>
          )}

          {activeTab === "goals" && (
          <SidebarGroup title="Life goals">
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <p className="text-[10px] text-neutral-500">
                Scheduled withdrawals (car, big purchases, etc.). Use &ldquo;auto-size&rdquo; to let
                one goal absorb whatever&apos;s available at its scheduled time.
              </p>
              <GoalsEditor goals={I.goals} setGoals={set("goals")} planStart={I.planStartDate} />
            </div>
          </SidebarGroup>
          )}

          {/* ============================ RETURNS & BALANCES ============================ */}
          {activeTab === "balances" && (
          <SidebarGroup title="Returns & starting balances">
            <Section title="Real returns (annual)">
              <NumField label="Market" value={I.rNomAnnual} onChange={set("rNomAnnual")} step={0.005} hint="real, ≈0.045" />
              <NumField label="Safe / cash" value={I.rSafeAnnual} onChange={set("rSafeAnnual")} step={0.005} hint="real, ≈0.01" />
              <NumField label="Inflation (display only)" value={I.inflationDisplay} onChange={set("inflationDisplay")} step={0.005} />
            </Section>
            <Section title="Withdrawal taxes">
              <NumField label="Cap gains rate" value={I.capGainsTaxRate} onChange={set("capGainsTaxRate")} step={0.01} hint="brokerage LTCG: 15+5% ≈ 0.20" />
              <NumField label="Retirement income rate" value={I.retirementWithdrawTaxRate} onChange={set("retirementWithdrawTaxRate")} step={0.01} hint="401k post-retirement ≈ 0.25" />
              <NumField label="Early withdraw penalty" value={I.earlyWithdrawPenalty} onChange={set("earlyWithdrawPenalty")} step={0.01} hint="pre-59½ 401k = 0.10" />
            </Section>
            <Section title="Starting balances">
              <NumField label="401k" value={I.bal401kStart} onChange={set("bal401kStart")} />
              <NumField label="HSA" value={I.balHsaStart} onChange={set("balHsaStart")} />
              <NumField label="Emergency fund" value={I.balEmergencyStart} onChange={set("balEmergencyStart")} />
              <NumField label="House fund" value={I.balHouseStart} onChange={set("balHouseStart")} />
              <NumField label="529" value={I.bal529Start} onChange={set("bal529Start")} />
              <NumField label="Brokerage" value={I.balBrokerageStart} onChange={set("balBrokerageStart")} />
            </Section>
            <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-neutral-400">Pull from Fidelity</h3>
              <FidelityImporter onApply={(v) => setI((prev) => ({
                ...prev,
                ...(v.bal401k !== undefined ? { bal401kStart: v.bal401k } : {}),
                ...(v.balHsa !== undefined ? { balHsaStart: v.balHsa } : {}),
                ...(v.bal529 !== undefined ? { bal529Start: v.bal529 } : {}),
                ...(v.balBrokerage !== undefined ? { balBrokerageStart: v.balBrokerage } : {}),
              }))} />
            </div>
          </SidebarGroup>
          )}

          {activeTab === "advanced" && (
          <div className="border border-neutral-800 rounded-lg">
            <div className="text-xs uppercase tracking-wider text-neutral-200 px-3 py-2 bg-neutral-900/40">
              Tax constants (Fed + MA, 2025)
            </div>
            <div className="p-3 grid grid-cols-2 gap-2">
              <NumField label="SS wage cap" value={I.ssWageCap} onChange={set("ssWageCap")} />
              <NumField label="Medicare surtax @ (single)" value={I.medicareSurtaxThreshold} onChange={set("medicareSurtaxThreshold")} />
              <NumField label="Medicare surtax @ (MFJ)" value={I.medicareSurtaxThresholdMFJ} onChange={set("medicareSurtaxThresholdMFJ")} />
              <NumField label="Fed std ded (single)" value={I.fedStdDeductionSingle} onChange={set("fedStdDeductionSingle")} />
              <NumField label="Fed std ded (MFJ)" value={I.fedStdDeductionMFJ} onChange={set("fedStdDeductionMFJ")} />
              <NumField label="MA exemption (single)" value={I.maPersonalExemptionSingle} onChange={set("maPersonalExemptionSingle")} />
              <NumField label="MA exemption (MFJ)" value={I.maPersonalExemptionMFJ} onChange={set("maPersonalExemptionMFJ")} />
              <NumField label="MA rate" value={I.maRate} onChange={set("maRate")} step={0.001} />
              <NumField label="MA surtax rate" value={I.maSurtaxRate} onChange={set("maSurtaxRate")} step={0.001} />
              <NumField label="MA surtax threshold" value={I.maSurtaxThreshold} onChange={set("maSurtaxThreshold")} />
              <NumField label="CTC per child" value={I.ctcPerChild} onChange={set("ctcPerChild")} />
              <NumField label="CTC phase-out (single)" value={I.ctcPhaseoutSingle} onChange={set("ctcPhaseoutSingle")} />
              <NumField label="CTC phase-out (MFJ)" value={I.ctcPhaseoutMFJ} onChange={set("ctcPhaseoutMFJ")} />
              <NumField label="CTC child max age" value={I.ctcChildMaxAge} onChange={set("ctcChildMaxAge")} />
            </div>
          </div>
          )}
        </div>

        {/* ---- Output ---- */}
        <div className="space-y-6 min-w-0">
          {/* Goal / retirement status flags */}
          {(goalStatuses.length > 0 || brokerageDepleteYear !== null || cascadeYear !== null) && (
            <Card title="Goals & retirement status">
              <div className="space-y-2">
                {brokerageDepleteYear !== null && (
                  <div className="flex items-start gap-2 text-sm border border-rose-900 bg-rose-950/40 rounded p-2">
                    <span className="text-rose-300">⚠</span>
                    <div className="flex-1">
                      <div className="text-rose-200 font-medium">
                        Liquid net worth depletes in {yearOffsetToYM(brokerageDepleteYear, I.planStartDate)}
                      </div>
                      <div className="text-xs text-rose-300/80 mb-2">
                        Drainage order when FCF can&apos;t cover spending: brokerage → emergency → house → 529 → 401k → HSA.
                        Every bucket runs dry before the horizon ends.
                      </div>
                      {depletionFix && (
                        <div className="text-xs text-rose-100 space-y-0.5">
                          <div>
                            <strong className="text-amber-200">Avoid full depletion (income):</strong> earn{" "}
                            {depletionFix.incomeMult === null ? (
                              <span className="text-rose-300">more than 200×</span>
                            ) : (
                              <strong>+{((depletionFix.incomeMult - 1) * 100).toFixed(1)}%</strong>
                            )}{" "}
                            on base + bonus + side income
                          </div>
                          <div>
                            <strong className="text-amber-200">Avoid full depletion (expenses):</strong> cut{" "}
                            {depletionFix.expenseCut === null ? (
                              <span className="text-rose-300">more than 99%</span>
                            ) : (
                              <strong>−{(depletionFix.expenseCut * 100).toFixed(1)}%</strong>
                            )}{" "}
                            from monthly standard expenses
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {cascadeYear !== null && (
                  <div className="flex items-start gap-2 text-sm border border-amber-900 bg-amber-950/30 rounded p-2">
                    <span className="text-amber-300">!</span>
                    <div className="flex-1">
                      <div className="text-amber-200 font-medium">
                        Brokerage runs short in {yearOffsetToYM(cascadeYear, I.planStartDate)} — dipping into emergency / house / 529 / 401k / HSA
                      </div>
                      <div className="text-xs text-amber-200/80 mb-2">
                        Plan may still survive, but you&apos;re touching reserves and tax-advantaged accounts
                        (with penalties pre-59½). Numbers below show what it takes to keep brokerage non-negative
                        so the cascade never fires.
                      </div>
                      {depletionFix && (
                        <div className="text-xs text-amber-100 space-y-0.5">
                          <div>
                            <strong className="text-amber-200">Don&apos;t touch reserves (income):</strong> earn{" "}
                            {depletionFix.incomeMultNoCascade === null ? (
                              <span className="text-rose-300">more than 200×</span>
                            ) : (
                              <strong>+{((depletionFix.incomeMultNoCascade - 1) * 100).toFixed(1)}%</strong>
                            )}{" "}
                            on base + bonus + side income
                          </div>
                          <div>
                            <strong className="text-amber-200">Don&apos;t touch reserves (expenses):</strong> cut{" "}
                            {depletionFix.expenseCutNoCascade === null ? (
                              <span className="text-rose-300">more than 99%</span>
                            ) : (
                              <strong>−{(depletionFix.expenseCutNoCascade * 100).toFixed(1)}%</strong>
                            )}{" "}
                            from monthly standard expenses
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {goalStatuses.length === 0 && brokerageDepleteYear === null && cascadeYear === null && (
                  <div className="text-xs text-neutral-500">No life goals set.</div>
                )}
                {goalStatuses.map((g) => {
                  const met = g.shortfall < 1;
                  return (
                    <div
                      key={g.goalId}
                      className={
                        "flex items-center justify-between gap-2 text-sm border rounded p-2 " +
                        (met
                          ? "border-emerald-900 bg-emerald-950/30"
                          : "border-rose-900 bg-rose-950/40")
                      }
                    >
                      <div>
                        <span className={met ? "text-emerald-300" : "text-rose-300"}>
                          {met ? "✓" : "⚠"}
                        </span>
                        <span className="ml-2 font-medium">{g.name}</span>
                        <span className="ml-2 text-xs text-neutral-400">
                          ({GOAL_KINDS.find((k) => k.value === g.kind)?.label})
                        </span>
                      </div>
                      <div className="text-xs">
                        <span className="text-neutral-400">scheduled </span>
                        <strong className="text-neutral-200">{fmt(g.scheduled)}</strong>
                        {!met && (
                          <>
                            <span className="text-neutral-600"> · </span>
                            <span className="text-rose-300">shortfall <strong>{fmt(g.shortfall)}</strong></span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {isBaseline && store.scenarios.length > 1 && (
            <div className="border border-neutral-800 rounded-lg p-3 text-xs text-neutral-400">
              This is the baseline scenario. Switch to a different scenario above to see how it compares against this one.
            </div>
          )}

          {comparison && (
            <Card title={`Retirement comparison vs "${comparison.baselineName}"`}>
              <div className="grid grid-cols-2 gap-4">
                <div className="border border-neutral-800 rounded-lg p-3">
                  <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    Same horizon ({yearOffsetToYM(comparison.baselineHorizonYears, I.planStartDate)})
                  </div>
                  <div className="text-2xl font-semibold mt-1">
                    <span className={comparison.delta >= 0 ? "text-emerald-300" : "text-rose-300"}>
                      {comparison.delta >= 0 ? "+" : "−"}{fmt(Math.abs(comparison.delta))}
                    </span>
                    <span className="text-sm text-neutral-400 font-normal"> in net worth</span>
                  </div>
                  <div className="text-xs text-neutral-400 mt-1">
                    This scenario: <strong>{fmt(comparison.aAtBaselineHorizon)}</strong>
                    <span className="text-neutral-500"> · Baseline: {fmt(comparison.bTargetNW)}</span>
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-2">
                    Sustainable spend (4% rule): <strong className="text-neutral-300">{fmt(comparison.aAtBaselineHorizon * 0.04)}</strong>/yr
                    <span className="text-neutral-600"> · baseline {fmt(comparison.bTargetNW * 0.04)}/yr</span>
                  </div>
                </div>

                <div className="border border-neutral-800 rounded-lg p-3">
                  <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    Same wealth target ({fmt(comparison.bTargetNW)})
                  </div>
                  {comparison.aReachMonth === null ? (
                    <div className="text-sm text-rose-300 mt-1">
                      Doesn&apos;t reach within {comparison.compareYears} years.
                    </div>
                  ) : (
                    (() => {
                      const aYears = comparison.aReachMonth / 12;
                      const diffYears = aYears - comparison.baselineHorizonYears;
                      const earlier = diffYears < 0;
                      return (
                        <>
                          <div className="text-2xl font-semibold mt-1">
                            <span className={earlier ? "text-emerald-300" : "text-rose-300"}>
                              {earlier ? "−" : "+"}{Math.abs(diffYears).toFixed(2)} yrs
                            </span>
                            <span className="text-sm text-neutral-400 font-normal">
                              {earlier ? " earlier" : " later"} retirement
                            </span>
                          </div>
                          <div className="text-xs text-neutral-400 mt-1">
                            Reaches target in <strong>{yearOffsetToYM(aYears, I.planStartDate)}</strong>
                            <span className="text-neutral-500"> · baseline reaches it in {yearOffsetToYM(comparison.baselineHorizonYears, I.planStartDate)}</span>
                          </div>
                        </>
                      );
                    })()
                  )}
                </div>
              </div>
              <div className="text-[10px] text-neutral-500 mt-3">
                Both scenarios extended to {comparison.compareYears} years for fair comparison. &ldquo;Quality of life&rdquo;
                uses the 4% safe-withdrawal heuristic: 4% × net worth ≈ sustainable annual spending in retirement.
              </div>
            </Card>
          )}

          <div className="grid grid-cols-4 gap-3">
            <Kpi
              label={`Final net worth at age 100 (real $)`}
              value={final ? fmt(final.netWorth) : "—"}
              sub={
                final && I.inflationDisplay > 0
                  ? `≈ ${fmt(final.netWorth * Math.pow(1 + I.inflationDisplay, Iresolved.horizonYears))} nominal @ ${(I.inflationDisplay * 100).toFixed(1)}% infl`
                  : undefined
              }
            />
            <Kpi label="Yr 1 gross" value={fmt(yearly[0]?.gross ?? 0)} />
            <Kpi label="Yr 1 total tax" value={fmt(yearly[0]?.taxes ?? 0)} />
            <Kpi
              label="Yr 1 effective rate"
              value={yearly[0] && yearly[0].gross > 0 ? ((yearly[0].taxes / yearly[0].gross) * 100).toFixed(1) + "%" : "—"}
            />
          </div>

          <Card title="Account balances over time">
            <div className="h-80">
              <ResponsiveContainer>
                <AreaChart data={chartData} margin={{ top: 36, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="year"
                    type="number"
                    domain={[0, "dataMax"]}
                    allowDecimals={false}
                    tick={{ fill: "#737373", fontSize: 11 }}
                    tickFormatter={(v) => {
                      const yrs = v as number;
                      const cal = (parseYM(I.planStartDate)?.y ?? new Date().getFullYear()) + Math.floor(yrs);
                      return `${cal}`;
                    }}
                  />
                  <YAxis
                    tick={{ fill: "#737373", fontSize: 11 }}
                    tickFormatter={(v) => fmtK(v as number)}
                    domain={["auto", "auto"]}
                    allowDataOverflow={false}
                  />
                  <ReferenceLine y={0} stroke="#525252" strokeWidth={1} />
                  <Tooltip
                    contentStyle={{ background: "#0a0a0a", border: "1px solid #262626", fontSize: 12 }}
                    formatter={(v) => fmt(v as number)}
                    labelFormatter={(v) => {
                      const yrs = v as number;
                      return `${yearOffsetToYM(yrs, I.planStartDate)}`;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="Emergency" stackId="nw" stroke="#94a3b8" fill="#334155" />
                  <Area type="monotone" dataKey="401k" stackId="nw" stroke="#60a5fa" fill="#1e3a8a" />
                  <Area type="monotone" dataKey="HSA" stackId="nw" stroke="#a78bfa" fill="#4c1d95" />
                  <Area type="monotone" dataKey="House" stackId="nw" stroke="#34d399" fill="#065f46" />
                  <Area type="monotone" dataKey="529" stackId="nw" stroke="#fbbf24" fill="#78350f" />
                  <Area type="monotone" dataKey="Brokerage" stackId="nw" stroke="#f472b6" fill="#831843" />
                  {(() => {
                    const lines: { x: number; label: string; color: string }[] = [];
                    if (I.homePurchaseYear > 0) lines.push({
                      x: I.homePurchaseYear, label: `Home`, color: "#34d399",
                    });
                    if (I.secondHomeYear > 0 && I.secondHomeValue > 0) lines.push({
                      x: I.secondHomeYear, label: `Move`, color: "#10b981",
                    });
                    for (const g of I.goals) {
                      if (g.kind === "car" && g.startYear > 0) {
                        lines.push({ x: g.startYear, label: g.name || "Car", color: "#fb923c" });
                      }
                    }
                    for (const c of I.children) {
                      if (c.birthYear > 0) {
                        lines.push({ x: c.birthYear, label: `${c.name} born`, color: "#60a5fa" });
                      }
                      if ((c.collegeAnnualCost ?? 0) > 0) {
                        const startAge = c.collegeStartAge ?? 18;
                        const birthM = yearToMonth(c.birthYear);
                        const birthPlanY = Math.max(1, Math.ceil(birthM / 12));
                        const collegeStartM = (birthPlanY - 1 + startAge) * 12 + 1;
                        lines.push({
                          x: collegeStartM / 12,
                          label: `${c.name} college`,
                          color: "#fbbf24",
                        });
                      }
                    }
                    if (I.marriageYear > 0) lines.push({
                      x: I.marriageYear, label: `Marry`, color: "#f472b6",
                    });
                    if (I.retirementYear > 0) lines.push({
                      x: I.retirementYear, label: `Retire`, color: "#facc15",
                    });
                    // Sort by x. Stagger labels vertically: cycle through 4
                    // dy offsets so adjacent ones never sit on the same line.
                    // All labels stay INSIDE the chart (no "top"/"bottom"
                    // positions, which would clip outside the plot area).
                    lines.sort((a, b) => a.x - b.x);
                    return lines.map((l, i) => (
                      <ReferenceLine
                        key={`ml-${i}`}
                        x={l.x}
                        stroke={l.color}
                        strokeDasharray="3 3"
                        strokeOpacity={0.55}
                        label={{
                          value: l.label,
                          position: "insideTop",
                          fill: l.color,
                          fontSize: 10,
                          offset: 6 + (i % 4) * 12,
                        }}
                      />
                    ));
                  })()}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Annual summary">
            <div className="max-h-[80vh] overflow-auto">
              <table className="w-full text-xs whitespace-nowrap [&_thead_th]:sticky [&_thead_th]:bg-neutral-950 [&_thead_th]:z-10">
                <thead>
                  {/* Group header — INFLOWS / OUTFLOWS / ACCOUNT FLOWS / NET */}
                  <tr className="text-[10px] uppercase tracking-wider text-neutral-500 border-b border-neutral-800 [&>th]:top-0">
                    <th />
                    <th colSpan={9} className="text-center text-emerald-400/80 py-1 border-l border-neutral-800">Inflows</th>
                    <th colSpan={11 + ownershipGoals.length} className="text-center text-rose-400/80 py-1 border-l border-neutral-800">Outflows (taxes + expenses)</th>
                    <th colSpan={8} className="text-center text-sky-400/80 py-1 border-l border-neutral-800">Account flows (your funds)</th>
                    <th colSpan={2} className="text-center text-neutral-300 py-1 border-l border-neutral-800">Net</th>
                  </tr>
                  <tr className="text-neutral-400 border-b border-neutral-800 [&>th]:top-[22px]">
                    <th className="text-left py-1.5 pr-3">Year</th>
                    {/* Inflows */}
                    <th className="text-right pr-3 border-l border-neutral-800">Base</th>
                    <th className="text-right pr-3">Bonus</th>
                    <th className="text-right pr-3">Side</th>
                    <th className="text-right pr-3">RSU</th>
                    <th className="text-right pr-3">ESPP disc</th>
                    <th className="text-right pr-3">401k er</th>
                    <th className="text-right pr-3">HSA er</th>
                    <th className="text-right pr-3">Gross</th>
                    <th className="text-right pr-3 font-semibold text-emerald-300">Total in</th>
                    {/* Outflows (taxes + expenses only) */}
                    <th className="text-right pr-3 border-l border-neutral-800">FICA</th>
                    <th className="text-right pr-3">Fed</th>
                    <th className="text-right pr-3">MA</th>
                    <th className="text-right pr-3">Property</th>
                    <th className="text-right pr-3">Cap gains</th>
                    <th className="text-right pr-3">Housing</th>
                    <th className="text-right pr-3">Inelastic</th>
                    <th className="text-right pr-3">Discretion</th>
                    <th className="text-right pr-3">Kids</th>
                    <th className="text-right pr-3">Medical (HSA)</th>
                    {ownershipGoals.map((g) => (
                      <th key={`hdr-own-${g.id}`} className="text-right pr-3 text-amber-300/80">{g.name}</th>
                    ))}
                    <th className="text-right pr-3 font-semibold text-rose-300">Total out</th>
                    {/* Account flows — every bucket you own */}
                    <th className="text-right pr-3 border-l border-neutral-800">401k net</th>
                    <th className="text-right pr-3">HSA net</th>
                    <th className="text-right pr-3">Emerg</th>
                    <th className="text-right pr-3">529</th>
                    <th className="text-right pr-3">House fund</th>
                    <th className="text-right pr-3">Brokerage</th>
                    <th className="text-right pr-3">Mkt growth</th>
                    <th className="text-right pr-3 font-semibold text-sky-300">Total flow</th>
                    {/* Net */}
                    <th className="text-right pr-3 border-l border-neutral-800">End NW</th>
                    <th className="text-left pl-3 min-w-[20rem] border-l border-neutral-800">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {yearly.map((y) => {
                    const totalIn = y.gross + y.empMatch + y.empHsa;
                    // housingPaid already includes property tax (via ownerCarryingMonthly);
                    // subtract it out for the display column so it doesn't double-count
                    // with the new Property column.
                    const housingExProp = y.housingPaid - y.taxProperty;
                    const ownershipTotal = ownershipGoals.reduce((sum, g) => sum + (y.goalOwnership.get(g.id) ?? 0), 0);
                    const totalOut = y.taxes + housingExProp + y.inelasticPaid + y.discretionaryPaid + y.kidCostPaid + y.collegePaid + y.medicalFromHsa + ownershipTotal;
                    const totalFlow = y.pmt401k + y.pmtHsa + y.empHsa + y.pmtEmergency + y.pmt529 + y.pmtHouse + y.pmtBrokerage + y.investmentGrowth;
                    return (
                    <tr key={y.year} className="border-b border-neutral-900">
                      <td className="py-1.5 pr-3 text-neutral-300">{y.year}</td>
                      {/* Inflows */}
                      <td className="text-right pr-3 border-l border-neutral-900">{fmt(y.iBase)}</td>
                      <td className="text-right pr-3">{fmt(y.iBonus)}</td>
                      <td className="text-right pr-3">{fmt(y.iSide)}</td>
                      <td className="text-right pr-3">{fmt(y.iRSU)}</td>
                      <td className="text-right pr-3">{fmt(y.iESPPdisc)}</td>
                      <td className="text-right pr-3 text-sky-300">{fmt(y.empMatch)}</td>
                      <td className="text-right pr-3 text-sky-300">{fmt(y.empHsa)}</td>
                      <td className="text-right pr-3">{fmt(y.gross)}</td>
                      <td className="text-right pr-3 font-semibold text-emerald-300">{fmt(totalIn)}</td>
                      {/* Outflows (taxes + expenses only) */}
                      <td className="text-right pr-3 border-l border-neutral-900 text-rose-300">{fmt(y.taxFICA)}</td>
                      <td className="text-right pr-3 text-rose-300">{fmt(y.taxFed)}</td>
                      <td className="text-right pr-3 text-rose-300">{fmt(y.taxState)}</td>
                      <td className="text-right pr-3 text-rose-300">{fmt(y.taxProperty)}</td>
                      <td className="text-right pr-3 text-rose-300">{fmt(y.taxCapGains)}</td>
                      <td className="text-right pr-3">{fmt(housingExProp)}</td>
                      <td className="text-right pr-3">{fmt(y.inelasticPaid)}</td>
                      <td className="text-right pr-3">{fmt(y.discretionaryPaid)}</td>
                      <td className="text-right pr-3">{fmt(y.kidCostPaid + y.collegePaid)}</td>
                      <td className="text-right pr-3">{fmt(y.medicalFromHsa)}</td>
                      {ownershipGoals.map((g) => (
                        <td key={`own-${g.id}`} className="text-right pr-3 text-amber-300/80">{fmt(y.goalOwnership.get(g.id) ?? 0)}</td>
                      ))}
                      <td className="text-right pr-3 font-semibold text-rose-300">{fmt(totalOut)}</td>
                      {/* Account flows */}
                      <td className="text-right pr-3 border-l border-neutral-900">{fmt(y.pmt401k)}</td>
                      <td className="text-right pr-3">{fmt(y.pmtHsa + y.empHsa)}</td>
                      <td className="text-right pr-3">{fmt(y.pmtEmergency)}</td>
                      <td className="text-right pr-3">{fmt(y.pmt529)}</td>
                      <td className="text-right pr-3">{fmt(y.pmtHouse)}</td>
                      <td className="text-right pr-3 text-sky-200">{fmt(y.pmtBrokerage)}</td>
                      <td className="text-right pr-3 text-emerald-300">{fmt(y.investmentGrowth)}</td>
                      <td className="text-right pr-3 font-semibold text-sky-300">{fmt(totalFlow)}</td>
                      {/* Net + Notes */}
                      <td className="text-right pr-3 font-medium border-l border-neutral-900">{fmt(y.endNetWorth)}</td>
                      <td className="text-left pl-3 text-[11px] text-amber-300 whitespace-normal min-w-[20rem] border-l border-neutral-900">
                        {y.goalNotes.size > 0
                          ? Array.from(y.goalNotes.entries()).map(([n, v]) => {
                              if (v.bySource.size > 0) {
                                const parts = Array.from(v.bySource.entries())
                                  .map(([src, amt]) => `${fmt(amt)} from ${src}`)
                                  .join(", ");
                                return `${n} ${fmt(v.total)} (${parts})`;
                              }
                              return `${n} ${fmt(v.total)}`;
                            }).join(" · ")
                          : ""}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="text-[10px] text-neutral-500 mt-2">
                <strong>Outflows</strong> = money truly leaving your wealth (taxes + expenses). Property tax is shown separately from
                Housing (Housing = mortgage P&amp;I + insurance + maintenance + HOA). Cap gains = realized capital-gains tax on
                brokerage withdrawals (deficit funding, home purchase, goals). <em>Medical (HSA)</em> = qualified medical paid out
                of the HSA — silent reduction to net worth that doesn&apos;t show up elsewhere.
                <strong> Account flows</strong> = money moving into / out of <em>your</em> buckets. HSA net includes employer contribution.
                401k net post-retirement turns negative as deficits draw 401k first.
                <em>Mkt growth</em> = compounding gain across all market buckets at the real return rate.
                <strong> Reconciliation:</strong> End NW = previous End NW + Total in − Total out + Mkt growth + (any net brokerage / bucket
                shifts). The Mkt growth column is the only piece that doesn&apos;t flow through Inflows/Outflows.
                401k er / HSA er = employer contributions (non-taxable; not part of taxable Gross).
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
