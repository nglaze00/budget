# Budget v2

## planning todos

401k doesn't decrease in graph
therapy 675
hsa says -1000
** max out hsa?
** 16% espp?
529 non qualified?

---

Personal finance app — SimpleFIN-powered transaction sync, custom dashboard, chat agent over your data. All-local, single Next.js process.

## Stack
- **Next.js 15** (App Router) — UI + API routes in one process
- **SQLite + Drizzle ORM** — local file, `./budget.db`
- **SimpleFIN Bridge** — bank connections (Chase, Capital One, Wells Fargo / Bilt, Fidelity, etc.). $15/yr flat.
- **Vercel AI SDK** (`ai` package) — chat agent; runs against OpenAI directly, no Vercel account needed
- **Tailwind v4**

## Data layers

- **`raw_transactions`** — append-only log. Every transaction payload we've ever fetched, with its source and a timestamp. Never updated. This is the source of truth.
- **`transactions`** — processed view. Derived from the latest raw payload per `transaction_id`. Holds `flow_type`, `category`, `is_paycheck`. User-set fields (`category` with `category_source='user'`, `user_note`) survive replays.

Re-processing: change `classify.ts`, the categorize prompt, or the paycheck heuristic, then `POST /api/replay` (or `POST /api/replay?recategorize=1` to also force LLM re-classification). No re-fetch from SimpleFIN needed.

## Core concepts

### Spending/earnings vs. cash flow
- **Spending/earnings** counts every transaction when it happens — a $50 credit-card swipe is $50 of spending the day you swipe.
- **Cash flow** only counts movement through depository (checking) accounts — a CC swipe is invisible until you pay the statement.

Transactions are tagged with `flow_type` (`spend` | `earn` | `transfer` | `cc_payment` | `unknown`) so both views are queries over the same rows. See `src/lib/classify.ts`.

SimpleFIN doesn't tell us if an account is credit vs checking, so each account has an `account_type` you set in `/link` after first sync.

### Auto-categorization
Each transaction gets a `category` from the v1 personal list (Income, Bills, Grocery, Solo necessary meals, Social food/drinks, Transit, Travel, Entertainment, Venmo/ATM, Clothing, Shopping, Medical, Exercise, Subscriptions, Investments, Credit card payments, Misc).

After every sync the app runs `lib/categorize.ts`: pulls any rows where `category IS NULL`, batches them 50 at a time, asks `gpt-4o-mini` to pick from the category list AND rate its confidence (`completely_sure` | `mostly_sure` | `unsure`). The pick is written with `category_source='llm'`; transactions tagged `unsure` show up at `/review` for a quick manual confirm. You can override any transaction; manual edits get `category_source='user'` and are protected from re-classification.

### Paycheck splitting
Deposits matching payroll heuristics get `is_paycheck=1`. After every sync, `lib/paychecks.ts` auto-splits each paycheck: it groups by normalized description (employer), takes the median of the ±3 neighboring paychecks as the regular baseline, and treats anything > 110% of that as bonus (`bonus = amount − baseline`, `regular = baseline`). Splits are stored with `source='auto'`. Confirming on `/paychecks` re-saves them as `source='user'`, which protects them from being re-computed on future syncs. The original transaction is never mutated.

## Setup

1. Sign up at https://bridge.simplefin.org ($15/yr).
2. In the SimpleFIN dashboard, connect your banks (Chase, Cap One, Wells Fargo, Fidelity).
3. Generate a **setup token** (base64 string, one-time use).
4. In this repo:
   ```powershell
   cd v2
   npm install --legacy-peer-deps
   npm run db:push
   npm run dev
   ```
5. Open http://localhost:3000/link, paste the setup token, click **Save + sync**.
6. After sync, mark each account as `credit` or `depository` on that same page.
7. Visit `/` for the dashboard.

To pull fresh transactions later, hit **Re-sync now** on `/link` (or `POST /api/sync`).

## Layout
```
v2/
  src/
    app/
      page.tsx              Dashboard
      link/page.tsx         SimpleFIN setup + account-type mapping
      cashflow/page.tsx     Spending vs cash flow view
      paychecks/page.tsx    Split regular vs bonus
      chat/page.tsx         Chat agent
      api/
        setup/              POST setup_token → claim access URL + initial sync
        sync/               POST → re-sync
        accounts/           GET / PATCH (set account_type)
        transactions/       GET
        stats/              GET — precomputed dashboard numbers
        paychecks/          GET/POST splits
        chat/               POST — streams agent response
    db/
      schema.ts             Drizzle table defs
      index.ts              SQLite client
    lib/
      simplefin.ts          Setup-token claim + /accounts sync
      classify.ts           flow_type heuristics
  drizzle.config.ts
```

## Next steps
- Design dashboard widgets (`/api/stats` is a stub returning raw totals).
- Add charts to `/cashflow` (recharts is already a dep).
- Tune `classify.ts` once you see real descriptions — CC-payment / transfer / paycheck regexes will need bank-specific tweaks.
- Auto-detect paycheck splits via a rule per employer.
