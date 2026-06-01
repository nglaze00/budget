# Budget — Android app

A native (Expo / React Native) port of the Budget **v2** desktop dashboard. It runs **all**
the same features on-device — SimpleFIN fetching, OpenAI categorization, the categorize chat,
review queue, transactions, and a planning view — against its own local SQLite database. The
phone is the primary device; the laptop syncs **on demand** over your LAN with a button tap, so
there is **zero background battery** cost.

## Feature parity

| Feature | Desktop (v2) | Android |
| --- | --- | --- |
| SimpleFIN fetch (raw → replay → transactions) | ✅ | ✅ |
| OpenAI categorization (confidence + alternatives) | ✅ | ✅ |
| Paycheck detection + splits | ✅ | ✅ |
| Review queue (confirm / re-categorize) | ✅ | ✅ |
| Categorize **chat** with bulk-apply tools | ✅ | ✅ |
| Dashboard (net worth, monthly trend, category bars, anomalies) | ✅ | ✅ |
| Transactions (search, month filter) | ✅ | ✅ |
| Planning | ✅ full tax/cashflow simulator | ✅ headline inputs + simplified projection¹ |
| Manual cross-device sync | ✅ | ✅ |

¹ The planning **data** (every scenario) syncs both ways losslessly. The mobile screen lets you
tweak the headline assumptions (income, expenses, returns, retirement, balances) and shows a
simplified net-worth projection. The full bracket-by-bracket tax + housing + withdrawal-waterfall
simulator remains on the desktop page; mobile edits preserve every other field untouched so
syncing never clobbers it.

## API keys / secrets you provide

1. **OpenAI API key** — required for categorization and chat. Both devices run all features, so
   enter it on **each** device. On Android it's stored in the OS secure keystore
   (`expo-secure-store`). Set it in **Settings** (gear icon on the Dashboard).
2. **SimpleFIN** — SimpleFIN setup tokens are **one-time use**. Claim it on **one** device
   (e.g. the desktop), then use **Sync** to copy the resulting long-lived access URL to the
   phone. You will not paste a second token. (You *can* alternatively claim a fresh token
   directly on the phone in Settings if you prefer.)

No other keys. Sync itself needs **no** cloud account — it's a direct LAN connection between
your two devices.

## Running it

There is **no Android SDK in this repo's build environment**, so the app is verified here only
by type-checking (`npx tsc --noEmit`) and Metro bundling (`npx expo export`). To actually run it
on your phone:

### Option A — Expo Go (easiest)
1. Install **Expo Go** from the Play Store on your Android phone.
2. On your computer:
   ```powershell
   cd c:\repos\budget\mobile
   npm install
   npx expo start
   ```
3. Scan the QR code with Expo Go. The app loads over your LAN.

### Option B — standalone dev build / sideloaded APK
Use EAS or a local prebuild if you want an installable APK:
```powershell
npx expo run:android      # requires Android Studio / SDK installed
# or: eas build -p android --profile preview
```

## Syncing (manual, LAN, battery-free)

Both devices keep a full local copy and work offline. Sync only happens while you hold both apps
open and tap a button — nothing runs in the background.

1. On the **desktop**, run the web app bound to your LAN so the phone can reach it:
   ```powershell
   cd c:\repos\budget\v2
   npx next dev -H 0.0.0.0
   ```
   The desktop **/sync** page shows its LAN address (e.g. `http://192.168.1.20:3000`).
2. On the **phone**, open the **Sync** tab and enter that desktop URL once (the "desktop peer
   URL" field). Both devices must be on the same Wi-Fi.
3. Tap:
   - **Sync from desktop** — pulls the desktop's snapshot and merges it into the phone.
   - **Send to desktop** — pushes the phone's snapshot to the desktop to merge.

The puller/sender does all the work; the other side just serves/accepts a JSON snapshot.

### Merge rules
- `raw_transactions` are append-only → **union** (conflict-free), then `transactions` are
  **rebuilt by replay**, so derived fields never conflict.
- User-authored data is **last-writer-wins** by `updated_at`, with the **phone winning exact
  ties** (it's primary): user categories/notes, account types, user paycheck splits, categories,
  and the planning blob.
- `connection.access_url` syncs so the phone inherits SimpleFIN access without a second token.

### Off-network fallback
If the two devices aren't on the same Wi-Fi, use the **Export snapshot** / **Import snapshot**
buttons on the Sync screen to move a `.json` file via the Android share sheet (or any file
transfer) and merge it on the other device. Same merge logic, no live connection needed.

## Architecture notes

- **Expo SDK 52**, expo-router, **Drizzle ORM** on the `expo-sqlite` driver. The Drizzle schema
  (`src/db/schema.ts`) is a 1:1 port of the desktop schema with `updated_at` sync columns.
- On-device migrations live in `src/db/migrate.ts` (`ensureSchema()`) — raw idempotent DDL kept
  in lockstep with the schema (no drizzle-kit on the phone).
- Business logic is ported from desktop `src/lib/*`: `simplefin`, `process`, `classify`,
  `categorize`, `paychecks`, `seed`, `similarity`, `stats`. Node-only bits were swapped:
  `Buffer` → a pure-JS `base64.ts`; the `ai`/`@ai-sdk/openai` SDK → a fetch-based `openai.ts`
  (`generateObject` via `response_format: json_schema`, plus a tool-calling loop for chat).
- The sync engine (`src/lib/syncEngine.ts`) mirrors the desktop contract in `v2/src/lib/sync.ts`
  exactly (`Snapshot` shape, last-writer-wins, phone wins ties). Keep the two in lockstep.
- Charts use `react-native-svg` only (Expo Go compatible) — no native chart modules.

## Project layout

```
mobile/
  app/
    _layout.tsx            # init gate (schema + seed + settings) and stack
    (tabs)/
      _layout.tsx          # Dashboard / Review / Transactions / Planning / Sync
      index.tsx            # Dashboard
      review.tsx           # Review queue + paycheck confirms
      transactions.tsx     # Searchable transaction list
      planning.tsx         # Scenario headline inputs + projection
      sync.tsx             # The two sync buttons + peer URL + file fallback
    settings.tsx           # OpenAI key/model, SimpleFIN, fetch, account types
    chat.tsx               # Categorize chat assistant
  src/
    db/      schema.ts · index.ts · migrate.ts
    lib/     simplefin · process · classify · categorize · paychecks · seed ·
             similarity · stats · openai · chat · settings · base64 · data ·
             format · syncEngine · syncClient · planning
    components/  Screen · Card · Button · Badge · Money · Charts · Stat
    theme/   index.ts
```
