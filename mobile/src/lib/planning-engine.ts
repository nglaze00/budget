// =====================================================================
// Planning simulation engine — ported VERBATIM from the desktop app
// (v2/src/app/planning/page.tsx, lines 14-1519). Pure TypeScript: tax
// brackets, mortgage amortization, RSU vesting, the full monthly capital
// -allocation waterfall, and the simulate() model. Kept byte-for-byte
// identical to the desktop so both platforms produce the same numbers.
// Only additions: an `export` block at the bottom + mobile storage/import
// helpers. DO NOT edit the math here without mirroring it on desktop.
// =====================================================================
/* eslint-disable */
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

// ===================== Mobile additions =====================
// (Everything above this line is the verbatim desktop engine.)

export interface Scenario { id: string; name: string; inputs: Inputs }
export interface ScenarioStore { scenarios: Scenario[]; activeId: string; baselineId?: string }

// Re-export the engine surface the mobile UI consumes.
export {
  DEFAULTS,
  simulate,
  mergeInputs,
  reanchorInputs,
  fmt,
  fmtK,
  houseCashTarget,
  mortgagePayment,
  ownerCarryingMonthly,
  effectiveExpenses,
  relativeDescription,
  yearOffsetToYM,
  ymToYearOffset,
  todayYM,
  parseYM,
};
export type { Inputs, Child, Goal, GoalKind, GoalStatus, CategoryRow, SimResult, MonthRow };

// ---- Goal kinds (ported from the desktop GoalsEditor) ----
export const GOAL_KINDS: { value: GoalKind; label: string; recurring: boolean; hint: string }[] = [
  { value: "car", label: "Car", recurring: false, hint: "One-time purchase + optional ongoing cost (insurance, gas, maintenance)." },
  { value: "kid_yearly", label: "Kid yearly", recurring: true, hint: "Annual cost over a window." },
  { value: "college", label: "College", recurring: true, hint: "Annual tuition; draws 529 first, then brokerage." },
  { value: "other", label: "Other", recurring: false, hint: "Any one-time or recurring withdrawal." },
];

// ---- Category-median import (mobile port of fetchCategoryMedians) ----
export type ExpenseBucket = "rent" | "inelastic" | "discretionary" | "medical" | "ignore";

export function classifyCategory(name: string): ExpenseBucket {
  const n = name.toLowerCase();
  if (/\brent\b|\bmortgage\b|\bhoa\b|housing/.test(n)) return "rent";
  if (n === "medical" || n === "healthcare" || n === "medical & healthcare") return "medical";
  if (
    /util|insurance|internet|phone|subscription|electric|water|sewer|trash|cable|cell|stream|tax|debt|loan|tuition|childcare|dues|membership|gym|fitness|interest|service/.test(n)
  ) return "inelastic";
  return "discretionary";
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
