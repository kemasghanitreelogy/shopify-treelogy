# Migration Preview: QBO ↔ Jubelio Canonical Sync

**Generated:** 2026-04-28 03:59:42

**Status:** PREVIEW — belum ada perubahan ke QBO. Review file ini, kalau OK kasih tau saya untuk apply.


## Keputusan Anda yang Saya Pakai

- ✅ Nota lama juga di-update pakai produk baru (riskier path, dengan mitigasi stock adjustment)
- ✅ Skip 3 produk Jubelio yang sudah arsip
- ✅ Bundle: bundle line di sum komponen, plus diskon line kalau bundle lebih murah
- ✅ Stok awal copy dari Jubelio current `available_qty`
- ✅ Bamboo Whisk dibuat baru sebagai Inventory
- ✅ 6 Bundle Jubelio jadi QBO Group items dengan komponen Inventory canonical
- ✅ Sample (id 39, 40) dipertahankan
- ✅ "Sales", "Hours", "Shipping Charge", Shopify items, Categories juga dipertahankan (sistem)

## Ringkasan Angka

| Operasi | Jumlah |
|---|---|
| Rename + set SKU produk legacy Inventory | **8** |
| Sudah benar (skip) | 1 |
| Buat Inventory baru | **1** |
| Service items dari integrasi → redirect lalu inactivate | **11** |
| Total nota line yang ke-redirect | 524 |
| Buat Group/Bundle items | **6** |
| Orphan legacy Inventory yang di-inactivate | 5 |
| Items yang dipertahankan | 27 |

## FASE 1 — Rename + Set SKU Legacy Inventory

Yang sudah ada di QBO sebagai Inventory legacy, tinggal di-rename + set SKU = match Jubelio.

| QBO id | Nama Sekarang | Nama Baru | SKU Baru | Match by | Status |
|---|---|---|---|---|---|
| 6 | Moringa Dried Leaf Powder 180grams | TREELOGY Premium Organic Moringa Powder / Bubuk Da | `OMP-180-001` | manual map | 🔧 patch |
| 22 | Moringa Dried Leaf Powder - 45grams | TREELOGY Premium Organic Moringa Powder / Bubuk Da | `OMP-45-001` | manual map | 🔧 patch |
| 9 | Moringa Dried Leaf Powder - 90grams | TREELOGY Premium Organic Moringa Powder / Bubuk Da | `OMP-90-001` | manual map | 🔧 patch |
| 20 | Moringa Capsules-180Pcs | TREELOGY Premium Organic Moringa Capsules / Kapsul | `OMC-180-001` | manual map | 🔧 patch |
| 18 | Moringa Capsules-90Pcs | TREELOGY Premium Organic Moringa Capsules / Kapsul | `OMC-90-001` | manual map | 🔧 patch |
| 15 | Moringa Seed Oil - 30ml | TREELOGY Premium Organic Moringa Seed Oil / Minyak | `OMO-30-001` | manual map | 🔧 patch |
| 16 | Moringa Seed Oil - 60ml | TREELOGY Premium Organic Moringa Seed Oil / Minyak | `OMO-60-001` | manual map | 🔧 patch |
| 13 | Moringa Ritual Set | TREELOGY Moringa Ritual Set (Moringa Ritual Set -  | `MRS-001` | manual map | 🔧 patch |
| 24 | Bamboo Scoop | Bamboo Scoop | `Bamboo-Scoop` | manual map | ✅ skip |

## FASE 2 — Buat Inventory Baru

| Nama | SKU | Stok Awal | Harga Jual |
|---|---|---|---|
| Bamboo Whisk - 120 prongs (Bamboo Whisk) | `Bamboo-Whisk` | 50 | Rp 290.000 |

## FASE 3 — Redirect Nota Lama dari Service ke Inventory/Bundle

Setiap line invoice yang reference Service item dari integrasi → di-redirect ke Inventory/Bundle yang benar.

| Service ID | Nama | SKU | Tujuan | # Nota | Total Qty | Total Rp |
|---|---|---|---|---|---|---|
| 50 | Inside Out Moringa Protocol copy | `Inside-Out-Protocol` | Bundle Inside-Out-Protocol | 11 | 11 | 7.590.000 |
| 54 | Jubelio Sync Item | `—` | ⚠️ TIDAK KETEMU | 7 | 8 | 5.140.000 |
| 42 | Premium Organic Moringa Capsules / Kapsu | `OMC-180-001` | Inventory 20 | 395 | 404 | 201.944.100 |
| 44 | Premium Organic Moringa Powder / Bubuk D | `OMP-45-001` | Inventory 22 | 33 | 36 | 15.693.181,82 |
| 53 | Premium Organic Moringa Powder / Bubuk D | `OMP-45-001` | Inventory 22 | 1 | 1 | 320.000 |
| 41 | Premium Organic Moringa Seed Oil / Minya | `OMO-60-001` | Inventory 16 | 47 | 49 | 27.139.700 |
| 49 | The Discovery Pack | Minyak, Bubuk & Kap | `—` | Bundle Discovery-Pack | 5 | 5 | 4.875.900 |
| 55 | The Discovery Pack | Minyak, Bubuk & Kap | `Discovery-Pack` | Bundle Discovery-Pack | 1 | 1 | 999.000 |
| 43 | The Movement & Relief | Moringa Daun Kel | `—` | Bundle The-Movement-&-Relief | 12 | 12 | 14.860.000 |
| 52 | The Movement & Relief | Moringa Daun Kel | `The-Movement-&-Relief` | Bundle The-Movement-&-Relief | 11 | 11 | 13.609.600 |
| 51 | TREELOGY Moringa Ritual Set | `—` | Inventory 13 | 1 | 1 | 760.000 |

## FASE 4 — Buat Group/Bundle Items di QBO

Setiap bundle Jubelio dibuat sebagai QBO Group item dengan komponen Inventory canonical.

### `MRS-003` — TREELOGY Moringa Ritual Set + Powder 90gr (Daily Wellness Bundle)
- Harga bundle: **Rp 1.450.000**
- Sum komponen: Rp 1.630.000
- 🟢 Diskon: **Rp 180.000** (akan jadi baris "Bundle Discount" di nota)
- Komponen:
  - `OMP-90-001` × 1 (Rp 540.000) → id=9
  - `MRS-001` × 1 (Rp 1.090.000) → id=13

### `Inside-Out-Protocol` — Inside Out  Moringa Protocol (Capsule 90 + Oil 30ml)
- Harga bundle: **Rp 690.000**
- Sum komponen: Rp 860.000
- 🟢 Diskon: **Rp 170.000** (akan jadi baris "Bundle Discount" di nota)
- Komponen:
  - `OMC-90-001` × 1 (Rp 390.000) → id=18
  - `OMO-30-001` × 1 (Rp 470.000) → id=15

### `Discovery-Pack` — Treelogy The Discovery Pack | Minyak, Bubuk & Kapsul Kelor Organik Premium – Kulit Cerah, Energi & I
- Harga bundle: **Rp 1.180.000**
- Sum komponen: Rp 1.180.000
- ✅ Tidak ada diskon (bundle = sum komponen)
- Komponen:
  - `OMP-45-001` × 1 (Rp 320.000) → id=22
  - `OMO-30-001` × 1 (Rp 470.000) → id=15
  - `OMC-90-001` × 1 (Rp 390.000) → id=18

### `MRS-004` — TREELOGY Moringa Ritual Set + Powder 180gr (The Complete Ritual Bundle)
- Harga bundle: **Rp 1.780.000**
- Sum komponen: Rp 2.080.000
- 🟢 Diskon: **Rp 300.000** (akan jadi baris "Bundle Discount" di nota)
- Komponen:
  - `OMP-180-001` × 1 (Rp 990.000) → id=6
  - `MRS-001` × 1 (Rp 1.090.000) → id=13

### `MRS-002` — TREELOGY Moringa Ritual Set + Powder 45gr (Ritual Starter Bundle)
- Harga bundle: **Rp 1.290.000**
- Sum komponen: Rp 1.410.000
- 🟢 Diskon: **Rp 120.000** (akan jadi baris "Bundle Discount" di nota)
- Komponen:
  - `OMP-45-001` × 1 (Rp 320.000) → id=22
  - `MRS-001` × 1 (Rp 1.090.000) → id=13

### `The-Movement-&-Relief` — TREELOGY The Movement & Relief | Moringa Daun Kelor Premium | 180 Kapsul + Oil 60ml | Bantu Pegal Se
- Harga bundle: **Rp 1.450.000**
- Sum komponen: Rp 1.480.000
- 🟢 Diskon: **Rp 30.000** (akan jadi baris "Bundle Discount" di nota)
- Komponen:
  - `OMO-60-001` × 1 (Rp 790.000) → id=16
  - `OMC-180-001` × 1 (Rp 690.000) → id=20

## FASE 5 — Inactivate Service Items Lama (setelah redirect)

11 Service items akan di-inactivate karena sudah di-replace oleh Inventory/Group items.

| QBO id | Nama | SKU | Bucket |
|---|---|---|---|
| 50 | Inside Out Moringa Protocol copy | `Inside-Out-Protocol` | JUBELIO_INTEGRATION |
| 54 | Jubelio Sync Item | `—` | JUBELIO_GENERIC_FALLBACK |
| 42 | Premium Organic Moringa Capsules / Kapsul Daun Kel | `OMC-180-001` | JUBELIO_INTEGRATION |
| 44 | Premium Organic Moringa Powder / Bubuk Daun Kelor  | `OMP-45-001` | JUBELIO_INTEGRATION |
| 53 | Premium Organic Moringa Powder / Bubuk Daun Kelor  | `OMP-45-001` | JUBELIO_INTEGRATION |
| 41 | Premium Organic Moringa Seed Oil / Minyak Biji Kel | `OMO-60-001` | JUBELIO_INTEGRATION |
| 49 | The Discovery Pack | Minyak, Bubuk & Kapsul Kelor  | `—` | AMBIGUOUS_SERVICE |
| 55 | The Discovery Pack | Minyak, Bubuk & Kapsul Kelor  | `Discovery-Pack` | JUBELIO_INTEGRATION |
| 43 | The Movement & Relief | Moringa Daun Kelor Premium | `—` | AMBIGUOUS_SERVICE |
| 52 | The Movement & Relief | Moringa Daun Kelor Premium | `The-Movement-&-Relief` | JUBELIO_INTEGRATION |
| 51 | TREELOGY Moringa Ritual Set | `—` | AMBIGUOUS_SERVICE |

## FASE 6 — Inactivate Orphan Legacy Inventory

Inventory legacy yang tidak match Jubelio canonical (kemungkinan barang lama / consignment yang sudah tidak dijual).

| QBO id | Nama | SKU |
|---|---|---|
| 11 | Consignment - Moringa Dried Leaf Powder - 90 grams | `—` |
| 8 | Consignment - Moringa Dried Leaf Powder - 180grams | `—` |
| 4 | Moringa Leaf Powder 180grams - Discounted Price | `—` |
| 38 | The Discovery Pack | `—` |
| 36 | The Movement & Relief | `—` |

## FASE 7 — Stock Adjustment ke Angka Jubelio Current

Setelah semua selesai, stok per Inventory di-adjust supaya match `available_qty` Jubelio.

| SKU | Target QtyOnHand (Jubelio) | QBO id |
|---|---|---|
| `OMP-180-001` | 48 | 6 |
| `OMP-45-001` | 285 | 22 |
| `OMP-90-001` | 242 | 9 |
| `OMC-180-001` | 386 | 20 |
| `OMC-90-001` | 479 | 18 |
| `OMO-30-001` | 251 | 15 |
| `OMO-60-001` | 88 | 16 |
| `MRS-001` | 96 | 13 |
| `Bamboo-Whisk` | 50 | NEW:Bamboo-Whisk |
| `Bamboo-Scoop` | 47 | 24 |

## ⚠️ Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Cross-type redirect (Service→Inventory) bikin stok periode lampau distort | Set InvStartDate ke awal periode + opening qty cukup tinggi, lalu Stock Adjustment di akhir untuk match Jubelio current |
| Nota lama gagal di-update karena tax / business validation error | Per-line try/catch, skip yang gagal + flag di audit log; tidak rollback batch |
| Bundle pricing dengan diskon menghasilkan invoice total beda | Bundle line + discount line dengan tag yang sama supaya jelas kelihatan di nota |
| QBO API rate limit (500 req/min) | Sequential dengan jeda; total ~200-300 calls untuk full migration |
| Backup hilang | Snapshot QBO state full ke file JSON sebelum apply (qbo-snapshot-pre-migration-{ts}.json) |
| Mid-migration failure → state inkonsisten | Setiap fase di-checkpoint; bisa resume dari fase mana saja |

## ✋ Sebelum Apply

1. Review file ini secara penuh
2. Pastikan QBO realm ID benar (production, bukan sandbox)
3. Backup QBO export Excel via UI sebagai cadangan tambahan
4. Pilih waktu apply yang minim aktivitas (mis. malam hari WIB)
5. Konfirmasi ke saya untuk lanjut → saya bikin script apply per-fase
