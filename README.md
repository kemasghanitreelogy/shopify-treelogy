# Shopify to QuickBooks Online Integration

Integrasi otomatis yang menerima webhook dari Shopify dan membuat Sales Receipt di QuickBooks Online (QBO). Setiap order baru di Shopify secara otomatis tercatat di QBO — termasuk customer, item, dan tax.

## Architecture

```
Shopify Order Created
        │
        ▼
  ┌─────────────┐     ┌───────────┐     ┌──────────────────┐
  │   Shopify    │────▶│  Vercel   │────▶│  QuickBooks      │
  │   Webhook    │     │  Server   │     │  Online API      │
  └─────────────┘     └─────┬─────┘     └──────────────────┘
                            │
                      ┌─────▼─────┐
                      │  MongoDB  │
                      │  Atlas    │
                      │  (Token)  │
                      └───────────┘
```

## Tech Stack

| Technology       | Version  | Purpose                          |
|------------------|----------|----------------------------------|
| Node.js          | 18+      | Runtime                          |
| Express          | 5.x      | HTTP server                      |
| intuit-oauth     | 4.x      | QBO OAuth 2.0 authentication     |
| node-quickbooks  | 2.x      | QBO API client                   |
| Mongoose         | 9.x      | MongoDB ODM                      |
| Vercel           | -        | Serverless deployment            |
| MongoDB Atlas    | -        | Token storage                    |

## Project Structure

```
shopify-qbo-integration/
├── index.js                 # Express app entry point
├── config/
│   └── db.js                # MongoDB connection (with retry & readyState check)
├── models/
│   └── Token.js             # OAuth token schema (tokenCreatedAt as Number)
├── routes/
│   ├── auth.js              # /api/auth/login & /api/auth/callback
│   └── webhook.js           # /api/webhook/shopify (main webhook handler)
├── services/
│   └── qboService.js        # QBO OAuth2 token management & instance factory
├── vercel.json              # Vercel deployment config
├── package.json
└── .env                     # Environment variables (not committed)
```

## Environment Variables

Buat file `.env` di root project (untuk development lokal) dan set di **Vercel Dashboard > Settings > Environment Variables** untuk production.

| Variable                | Required | Description                                       | Example                                                    |
|-------------------------|----------|---------------------------------------------------|------------------------------------------------------------|
| `MONGODB_URI`           | Yes      | MongoDB Atlas connection string                   | `mongodb+srv://user:pass@cluster.mongodb.net/shopify-qbo`  |
| `QBO_CLIENT_ID`         | Yes      | Intuit Developer App client ID                    | `ABcDeFgHiJkLmNoPqRsTuVwXyZ`                              |
| `QBO_CLIENT_SECRET`     | Yes      | Intuit Developer App client secret                | `aBcDeFgHiJkLmNoPqRsTuVwXyZ`                              |
| `QBO_REDIRECT_URI`      | Yes      | OAuth callback URL                                | `https://your-app.vercel.app/api/auth/callback`            |
| `QBO_ENVIRONMENT`       | Yes      | `sandbox` atau `production`                       | `sandbox`                                                  |
| `SHOPIFY_WEBHOOK_SECRET`| Yes      | Shopify webhook signing secret                    | `whsec_aBcDeFgHiJk`                                       |
| `QBO_TAX_CODE`          | No       | Override tax code ID (auto-detected jika kosong)  | `5`                                                        |
| `QBO_INCOME_ACCOUNT_ID` | No       | Override income account ID (auto-detected)        | `54`                                                       |

## Setup

### 1. Clone & Install

```bash
git clone <repo-url>
cd shopify-qbo-integration
npm install
```

### 2. MongoDB Atlas

1. Buat cluster di [MongoDB Atlas](https://cloud.mongodb.com)
2. **Network Access** > Add IP Address > **Allow Access From Anywhere** (`0.0.0.0/0`)
   - Wajib untuk Vercel karena IP serverless berubah-ubah
3. **Database Access** > Buat database user
4. Copy connection string ke `MONGODB_URI`

### 3. Intuit Developer App

1. Buka [Intuit Developer](https://developer.intuit.com)
2. Buat app baru dengan scope **Accounting**
3. Set **Redirect URI** ke `https://your-app.vercel.app/api/auth/callback`
4. Copy Client ID & Client Secret

### 4. Deploy ke Vercel

```bash
npm i -g vercel
vercel
```

Set semua environment variables di Vercel Dashboard.

### 5. Authorize QBO

Buka browser dan akses:

```
https://your-app.vercel.app/api/auth/login
```

Login ke QBO dan authorize. Token akan tersimpan otomatis di MongoDB.

### 6. Shopify Webhook

1. Buka Shopify Admin > **Settings** > **Notifications** > **Webhooks**
2. Buat webhook baru:
   - **Event**: Order creation
   - **URL**: `https://your-app.vercel.app/api/webhook/shopify`
   - **Format**: JSON
3. Copy **Webhook signing secret** ke env var `SHOPIFY_WEBHOOK_SECRET`

## API Endpoints

### `GET /`

Health check. Returns `"Shopify to QBO Integration is running."`

### `GET /api/auth/login`

Redirect ke Intuit OAuth. User login dan authorize akses ke QBO company.

### `GET /api/auth/callback`

OAuth callback. Menerima authorization code dari Intuit, exchange ke token, simpan ke MongoDB.

### `POST /api/webhook/shopify`

Menerima Shopify order webhook. Memproses order dan buat Sales Receipt di QBO.

**Headers required by Shopify:**
- `x-shopify-hmac-sha256` — HMAC signature untuk verifikasi

---

## Code Documentation

### `index.js` — Entry Point

```
Express app initialization
├── connectDB()              # Connect ke MongoDB
├── express.json()           # Parse JSON body + capture rawBody untuk HMAC
├── /api/auth                # Auth routes (login, callback)
├── /api/webhook             # Webhook routes (shopify)
└── GET /                    # Health check
```

`rawBody` di-capture via `verify` callback di `express.json()` karena Shopify HMAC verification membutuhkan raw request body (bukan parsed JSON).

---

### `config/db.js` — Database Connection

- **`readyState` check**: Skip reconnect jika sudah connected (Vercel warm start)
- **`serverSelectionTimeoutMS: 10000`**: Timeout 10 detik, tidak hang selamanya
- **`throw error`** (bukan `process.exit`): Agar Vercel function tidak langsung terminate

---

### `models/Token.js` — Token Schema

```javascript
{
    realmId:                  String,   // QBO Company ID (unique)
    token_type:               String,   // "bearer"
    access_token:             String,   // QBO API access token (1 hour TTL)
    refresh_token:            String,   // Refresh token (100 day TTL, rotates)
    expires_in:               Number,   // Access token lifetime in seconds (3600)
    x_refresh_token_expires_in: Number, // Refresh token lifetime in seconds
    tokenCreatedAt:           Number,   // Unix timestamp (ms) saat token dibuat
    createdAt:                Date,     // Mongoose auto-managed
    updatedAt:                Date,     // Mongoose auto-managed
}
```

**Penting:** `tokenCreatedAt` disimpan sebagai `Number` (bukan `Date`) karena library `intuit-oauth` melakukan arithmetic `createdAt + expires_in * 1000`. Jika `createdAt` adalah Date object, JavaScript melakukan string concatenation (bukan addition), menyebabkan `isAccessTokenValid()` selalu return `false`.

---

### `services/qboService.js` — Token Management

Modul ini mengelola OAuth 2.0 token lifecycle dan membuat QuickBooks API instance.

#### `oauthClient` (module-level singleton)

Instance `intuit-oauth` OAuthClient yang diinisialisasi dari env vars. Digunakan oleh auth routes (login/callback) dan untuk token refresh.

#### `refreshAndSave(realmId)`

1. Panggil `oauthClient.refresh()` ke Intuit token endpoint
2. Simpan token baru (access + refresh) ke MongoDB
3. Update `tokenCreatedAt` dengan timestamp baru

#### `getQboInstance()`

Main function yang dipanggil setiap webhook. Flow:

```
Load token dari MongoDB
        │
        ▼
Reconstruct token object (createdAt as Number)
        │
        ▼
oauthClient.setToken(tokenForOAuth)
        │
        ▼
isAccessTokenValid()?  ──Yes──▶  Create QuickBooks instance
        │
       No
        │
        ▼
refreshAndSave() ──Success──▶  Create QuickBooks instance
        │
      Fail (race condition?)
        │
        ▼
Reload token dari DB
        │
        ▼
Token berubah? ──Yes──▶  Pakai token baru, retry refresh jika perlu
        │
       No
        │
        ▼
Throw error: "Silakan login ulang"
```

**Concurrent refresh protection:** Variable `refreshInProgress` menyimpan Promise dari refresh yang sedang berjalan. Jika multiple webhook requests masuk bersamaan, hanya 1 yang melakukan refresh, sisanya menunggu Promise yang sama.

**Race condition handling:** Jika refresh gagal, function reload token dari MongoDB. Jika `refresh_token` sudah berubah (instance lain berhasil refresh duluan), gunakan token yang baru.

#### QuickBooks Constructor Parameters

```javascript
new QuickBooks(
    clientId,        // param 1: QBO app client ID
    clientSecret,    // param 2: QBO app client secret
    accessToken,     // param 3: Current access token
    false,           // param 4: tokenSecret (not used in OAuth 2.0)
    realmId,         // param 5: QBO company ID
    useSandbox,      // param 6: true for sandbox environment
    debug,           // param 7: true if NODE_ENV !== 'production'
    '65',            // param 8: QBO API minor version
    '2.0',           // param 9: OAuth version — MUST be '2.0'
    refreshToken     // param 10: Current refresh token
)
```

**Parameter ke-9 harus `'2.0'`**. Tanpa ini, library menggunakan OAuth 1.0 dan throw `tokenSecret not defined`.

---

### `routes/auth.js` — OAuth Flow

#### `GET /api/auth/login`

1. Generate Intuit authorization URL dengan scope `Accounting`
2. Redirect user ke Intuit login page

#### `GET /api/auth/callback`

1. Terima authorization code dari Intuit redirect
2. Exchange code ke token via `oauthClient.createToken()`
3. Simpan semua token fields + `tokenCreatedAt` ke MongoDB (upsert by realmId)

---

### `routes/webhook.js` — Shopify Webhook Handler

#### `verifyShopifyWebhook(req)` — HMAC Verification

Setiap request diverifikasi dengan HMAC-SHA256:
1. Generate hash dari `rawBody` menggunakan `SHOPIFY_WEBHOOK_SECRET`
2. Compare dengan header `x-shopify-hmac-sha256`
3. Reject dengan 401 jika tidak cocok

#### `extractQboError(err, body)` — Error Helper

Extract error detail dari QBO API responses. `node-quickbooks` callback pattern: `callback(err, body, res)` — pada HTTP error, `err` adalah axios error (generic message), sedangkan `body` (argument ke-2) berisi `Fault.Error` dengan detail sebenarnya.

Urutan pengecekan:
1. `body.Fault.Error` — QBO error dari callback arg ke-2
2. `err.Fault.Error` — QBO fault di 200 response
3. `err.response.data.Fault.Error` — QBO error di axios response
4. `err.message` — Fallback generic message

#### `getDefaultTaxCode(qbo)` — Auto-detect Tax Code

1. Cek env var `QBO_TAX_CODE` (manual override)
2. Cek cache (per warm instance)
3. Query QBO `findTaxCodes`, prefer zero-rate/exempt code (FRE, NON, GST free, dll)
4. Cache hasilnya untuk request berikutnya

#### `getIncomeAccountId(qbo)` — Auto-detect Income Account

1. Cek env var `QBO_INCOME_ACCOUNT_ID` (manual override)
2. Cek cache
3. Query QBO for accounts with `AccountType = 'Income'`
4. Prefer account yang mengandung "Sales", "Revenue", "Pendapatan"

#### `getOrCreateCustomer(qbo, customerData)` — Find or Create Customer

1. Cari customer di QBO by email (`PrimaryEmailAddr`)
2. Jika ditemukan, return ID-nya
3. Jika tidak, buat customer baru dengan `GivenName`, `FamilyName`, `DisplayName`, `PrimaryEmailAddr`
4. `DisplayName` format: `"FirstName LastName (email)"` — harus unik di QBO

#### `getOrCreateItem(qbo, itemName, price, incomeAccountId)` — Find or Create Item

1. Cari item di QBO by `Name` (exact match)
2. Jika ditemukan, return ID-nya
3. Jika tidak, auto-create sebagai `Service` type:
   - `Name`: Product name dari Shopify (max 100 chars, single quotes removed)
   - `Type`: `'Service'`
   - `IncomeAccountRef`: Income account yang terdeteksi
   - `UnitPrice`: Harga dari Shopify

#### Webhook Processing Flow

```
POST /api/webhook/shopify
        │
        ▼
  Verify HMAC ──Fail──▶ 401 Unauthorized
        │
      Valid
        │
        ▼
  getQboInstance()           # Token management + auto-refresh
        │
        ▼
  Promise.all([              # Parallel metadata fetch
    getDefaultTaxCode(),     # → e.g. "GST free" (ID: 5)
    getIncomeAccountId()     # → e.g. "Revenue - General" (ID: 54)
  ])
        │
        ▼
  getOrCreateCustomer()      # Find by email or create new
        │
        ▼
  For each line_item:
    ├── parseFloat(price)    # String → Number
    ├── Math.round(amount)   # Avoid floating point issues
    └── getOrCreateItem()    # Find or auto-create in QBO
        │
        ▼
  createSalesReceipt({
    Line: lineItems,
    CustomerRef,
    CurrencyRef
  })
        │
        ▼
  200 OK "Success"
```

---

## Token Lifecycle

```
                    ┌─────────────────────────┐
                    │  /api/auth/login         │
                    │  User authorizes QBO     │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  /api/auth/callback      │
                    │  Save tokens to MongoDB  │
                    │  (access + refresh +     │
                    │   tokenCreatedAt)        │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              ▼                                     ▼
    Access token valid              Access token expired
    (< 1 hour old)                  (> 1 hour old)
              │                                     │
              ▼                                     ▼
    Use directly                    oauthClient.refresh()
                                            │
                                  ┌─────────┴──────────┐
                                  │                    │
                                  ▼                    ▼
                            Success                  Fail
                                  │                    │
                                  ▼                    ▼
                            Save new tokens      Retry: reload from DB
                            to MongoDB           (race condition check)
                                  │                    │
                                  ▼                    ▼
                            Use new token        Token changed?
                                               Yes → use it
                                               No  → "Login ulang"
```

- **Access token**: Berlaku 1 jam. Auto-refresh tanpa user interaction.
- **Refresh token**: Berlaku 100 hari. Rotates setiap kali digunakan (old token invalidated, new token issued dan disimpan).
- **Login ulang** hanya diperlukan jika refresh token expired (>100 hari tanpa aktivitas).

---

## Troubleshooting

| Error | Penyebab | Solusi |
|-------|----------|--------|
| `tokenSecret not defined` | Parameter QuickBooks constructor salah urutan | Pastikan param ke-9 adalah `'2.0'` |
| `Refresh token invalid` | Refresh token expired (>100 hari) atau race condition | Akses `/api/auth/login` untuk re-authorize |
| `MongoDB Connection Error` | IP tidak di-whitelist atau cluster paused | Atlas: Network Access > allow `0.0.0.0/0`; cek cluster tidak paused |
| `isAccessTokenValid() always false` | `createdAt` disimpan sebagai Date bukan Number | Pastikan schema pakai `tokenCreatedAt: Number` |
| `Property Query not found` | `findCustomers({ Query: ... })` format salah | Gunakan array criteria: `[{ field, value, operator }]` |
| `GST rate` / tax error | TaxCodeRef hardcoded `"NON"` tidak valid | Code auto-detects; atau set `QBO_TAX_CODE` env var |
| `Request failed with status code 400` | QBO error detail tersembunyi di axios error | `extractQboError(err, body)` extract dari callback arg ke-2 |

---

## Expected Log Output (Success)

```
✅ HMAC Valid. Memproses order ID: 820982911946154500
MongoDB Connected
✅ QBO instance berhasil dibuat.
🏷️ Tax code: "GST free" (ID: 5)
💰 Income account: "Revenue - General" (ID: 54)
👤 Customer ditemukan: John Smith (john@example.com) (ID: 70)
✅ Customer ID: 70
🆕 Auto-creating item: Organic Moringa Powder
✅ Item created: Organic Moringa Powder (ID: 26)
📦 SalesReceipt payload: { ... }
🚀 Sales Receipt Berhasil! ID: 196
```

## License

