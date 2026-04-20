const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');
const { getSalesOrder } = require('../services/jubelioService');
const JubelioOrderMap = require('../models/JubelioOrderMap');

// ─── Jubelio HMAC Verification ───
// Per docs: SHA256( JSON.stringify(payload) + secret_key )
// NOTE: Jubelio displays the secret with a literal `base64:` prefix in the UI.
// That prefix is part of the secret string — store it verbatim in
// JUBELIO_WEBHOOK_SECRET (e.g. `base64:GDVcKSmLA2lX...`). Do not base64-decode.
const verifyJubelioSignature = (req) => {
    const secret = process.env.JUBELIO_WEBHOOK_SECRET;
    if (!secret) {
        console.warn('⚠️ JUBELIO_WEBHOOK_SECRET belum di-set — signature check di-skip.');
        return true;
    }

    const headerName = (process.env.JUBELIO_SIGNATURE_HEADER || 'x-hook-signature').toLowerCase();
    const received = req.headers[headerName]
        || req.headers['x-jubelio-hmac-sha256']
        || req.headers['x-signature'];

    if (!received) {
        console.error(`⚠️ Signature header "${headerName}" tidak ditemukan.`);
        return false;
    }

    if (!req.rawBody) {
        console.error('⚠️ req.rawBody tidak ditemukan.');
        return false;
    }

    // Jubelio spec: stringify(payload) + secret. rawBody is the exact string payload.
    const base = req.rawBody.toString('utf8') + secret;
    const expected = crypto.createHash('sha256').update(base).digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(received).trim(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

// ─── QBO Error Helper ───
const extractQboError = (err, body) => {
    if (body?.Fault?.Error) return body.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.Fault?.Error) return err.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.response?.data?.Fault?.Error) return err.response.data.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.response?.data) return JSON.stringify(err.response.data);
    return err?.message || String(err);
};

// ─── QBO Metadata Cache ───
let _cachedTaxCodeId = null;
let _cachedIncomeAccountId = null;

const getDefaultTaxCode = (qbo) => {
    if (process.env.QBO_TAX_CODE) return Promise.resolve(process.env.QBO_TAX_CODE);
    if (_cachedTaxCodeId) return Promise.resolve(_cachedTaxCodeId);
    return new Promise((resolve) => {
        qbo.findTaxCodes([], (err, body) => {
            const codes = body?.QueryResponse?.TaxCode;
            if (codes && codes.length > 0) {
                const zeroRate = codes.find(c =>
                    c.Active !== false && (
                        /free|exempt|zero|nil|none|nol|bebas/i.test(c.Name) ||
                        c.Name === 'FRE' || c.Name === 'Z' || c.Name === 'NON'
                    )
                );
                _cachedTaxCodeId = zeroRate ? String(zeroRate.Id) : String(codes[0].Id);
            } else {
                _cachedTaxCodeId = null;
            }
            resolve(_cachedTaxCodeId);
        });
    });
};

const getIncomeAccountId = (qbo) => {
    if (process.env.QBO_INCOME_ACCOUNT_ID) return Promise.resolve(process.env.QBO_INCOME_ACCOUNT_ID);
    if (_cachedIncomeAccountId) return Promise.resolve(_cachedIncomeAccountId);
    return new Promise((resolve) => {
        qbo.findAccounts(
            [{ field: 'AccountType', value: 'Income', operator: '=' }],
            (err, body) => {
                const accounts = body?.QueryResponse?.Account;
                if (accounts && accounts.length > 0) {
                    const sales = accounts.find(a => /sales|revenue|pendapatan|penjualan/i.test(a.Name)) || accounts[0];
                    _cachedIncomeAccountId = String(sales.Id);
                } else {
                    _cachedIncomeAccountId = null;
                }
                resolve(_cachedIncomeAccountId);
            }
        );
    });
};

// ─── Customer lookup (by email or display name) ───
const getOrCreateCustomer = (qbo, so) => {
    return new Promise((resolve, reject) => {
        const email = so.customer_email;
        const displayName = (so.customer_name || 'Jubelio Customer').trim().substring(0, 100);

        const finish = (id) => resolve(id);
        const createNew = () => {
            const payload = {
                DisplayName: email ? `${displayName} (${email})` : displayName,
                GivenName: displayName.split(' ')[0] || 'Jubelio',
                FamilyName: displayName.split(' ').slice(1).join(' ') || 'Customer',
            };
            if (email) payload.PrimaryEmailAddr = { Address: email };
            if (so.customer_phone) payload.PrimaryPhone = { FreeFormNumber: String(so.customer_phone) };
            qbo.createCustomer(payload, (errC, bodyC) => {
                if (errC) return reject(new Error('createCustomer: ' + extractQboError(errC, bodyC)));
                console.log(`✅ Customer baru: ${bodyC.Id}`);
                finish(bodyC.Id);
            });
        };

        if (email) {
            qbo.findCustomers(
                [{ field: 'PrimaryEmailAddr', value: email, operator: '=' }],
                (err, body) => {
                    if (err) return reject(new Error('findCustomers: ' + extractQboError(err, body)));
                    if (body?.QueryResponse?.Customer?.length > 0) {
                        return finish(body.QueryResponse.Customer[0].Id);
                    }
                    createNew();
                }
            );
        } else {
            createNew();
        }
    });
};

// ─── Item lookup (by item_code or item_name) ───
const getOrCreateItem = (qbo, item, incomeAccountId) => {
    return new Promise((resolve) => {
        const lookupName = (item.item_name || item.description || 'Jubelio Item').replace(/'/g, '').substring(0, 100);

        qbo.findItems([{ field: 'Name', value: lookupName, operator: '=' }], (err, body) => {
            if (!err && body?.QueryResponse?.Item?.length > 0) {
                return resolve(body.QueryResponse.Item[0].Id);
            }
            if (!incomeAccountId) {
                console.log(`⚠️ Item '${lookupName}' tidak ada & tidak bisa auto-create`);
                return resolve(null);
            }
            qbo.createItem({
                Name: lookupName,
                Type: 'Service',
                IncomeAccountRef: { value: incomeAccountId },
                UnitPrice: Number(item.sell_price || item.price) || 0,
            }, (errC, bodyC) => {
                if (errC) {
                    console.log(`⚠️ createItem gagal '${lookupName}':`, extractQboError(errC, bodyC));
                    return resolve(null);
                }
                console.log(`✅ Item created: ${lookupName} (ID: ${bodyC.Id})`);
                resolve(bodyC.Id);
            });
        });
    });
};

// ─── Build QBO Invoice Line array from Jubelio SO ───
const buildLines = async (qbo, so, taxCodeId, incomeAccountId) => {
    const lines = [];
    const items = Array.isArray(so.items) ? so.items : [];
    for (const it of items) {
        const qty = Number(it.qty_in_base ?? it.qty ?? 1) || 1;
        const price = Number(it.sell_price ?? it.price ?? 0) || 0;
        const lineAmount = Number(it.amount ?? (qty * price));
        const amount = Math.round(lineAmount * 100) / 100;

        const itemId = await getOrCreateItem(qbo, it, incomeAccountId);
        const detail = { Qty: qty, UnitPrice: price };
        if (itemId) detail.ItemRef = { value: itemId };
        if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };

        lines.push({
            Description: it.description || it.item_name || it.item_code,
            Amount: amount,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
        });
    }

    // Shipping fee (if any) as extra line
    const shipping = Number(so.shipping_cost || 0);
    if (shipping > 0) {
        const detail = { Qty: 1, UnitPrice: shipping };
        if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
        lines.push({
            Description: `Shipping (${so.courier || so.shipper || 'N/A'})`,
            Amount: Math.round(shipping * 100) / 100,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
        });
    }

    return lines;
};

// ─── Promisified QBO helpers ───
const qboGetInvoice = (qbo, id) => new Promise((resolve, reject) => {
    qbo.getInvoice(id, (err, body) => err ? reject(new Error('getInvoice: ' + extractQboError(err, body))) : resolve(body));
});
const qboCreateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.createInvoice(payload, (err, body) => err ? reject(new Error('createInvoice: ' + extractQboError(err, body))) : resolve(body));
});
const qboUpdateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(new Error('updateInvoice: ' + extractQboError(err, body))) : resolve(body));
});

// ─── Upsert Invoice ───
const upsertQboInvoice = async (qbo, so, realmId) => {
    const [taxCodeId, incomeAccountId] = await Promise.all([
        getDefaultTaxCode(qbo),
        getIncomeAccountId(qbo),
    ]);

    const customerId = await getOrCreateCustomer(qbo, so);
    const lines = await buildLines(qbo, so, taxCodeId, incomeAccountId);

    if (lines.length === 0) {
        throw new Error('Jubelio SO tidak punya items — tidak bisa buat Invoice.');
    }

    const existing = await JubelioOrderMap.findOne({ salesorder_id: so.salesorder_id });

    const basePayload = {
        Line: lines,
        CustomerRef: { value: String(customerId) },
        DocNumber: String(so.salesorder_no || '').substring(0, 21) || undefined,
        TxnDate: so.transaction_date ? String(so.transaction_date).substring(0, 10) : undefined,
        PrivateNote: `Jubelio SO #${so.salesorder_no} (id ${so.salesorder_id})`,
    };

    if (existing) {
        console.log(`♻️ Update QBO Invoice ${existing.qbo_invoice_id} untuk SO ${so.salesorder_no}`);
        const current = await qboGetInvoice(qbo, existing.qbo_invoice_id);
        const updated = await qboUpdateInvoice(qbo, {
            ...basePayload,
            Id: existing.qbo_invoice_id,
            SyncToken: current.SyncToken,
            sparse: true,
        });
        await JubelioOrderMap.updateOne(
            { salesorder_id: so.salesorder_id },
            {
                qbo_doc_number: updated.DocNumber,
                last_status: so.status,
                last_grand_total: so.grand_total,
                last_synced_at: new Date(),
            }
        );
        return { action: 'updated', qbo_invoice_id: updated.Id };
    }

    console.log(`🆕 Create QBO Invoice untuk SO ${so.salesorder_no}`);
    const created = await qboCreateInvoice(qbo, basePayload);
    await JubelioOrderMap.create({
        salesorder_id: so.salesorder_id,
        salesorder_no: so.salesorder_no,
        qbo_realm_id: realmId,
        qbo_invoice_id: String(created.Id),
        qbo_doc_number: created.DocNumber,
        last_status: so.status,
        last_grand_total: so.grand_total,
        last_synced_at: new Date(),
    });
    return { action: 'created', qbo_invoice_id: String(created.Id) };
};

// ─── Webhook: Pesanan / Sales Order (create, update, status change) ───
// Jubelio action examples: "update-salesorder"
// Full payload carries items, customer, shipping, totals — no extra fetch needed.
router.post('/pesanan', async (req, res) => {
    if (!verifyJubelioSignature(req)) {
        return res.status(401).send('Unauthorized');
    }

    const payload = req.body || {};
    console.log(`✅ Jubelio /pesanan: action=${payload.action} SO=${payload.salesorder_no} id=${payload.salesorder_id} status=${payload.status}`);

    try {
        // Webhook already carries full SO; fall back to API only if items missing.
        let so = payload;
        if (!Array.isArray(so.items) || so.items.length === 0) {
            console.log('ℹ️ items kosong di webhook, fetch dari Jubelio API...');
            so = await getSalesOrder(payload.salesorder_id);
        }

        if (!so.salesorder_id) {
            return res.status(400).send('Missing salesorder_id');
        }

        if (so.is_canceled) {
            console.log(`⚠️ SO ${so.salesorder_no} dibatalkan — skipping (tambahkan void logic jika perlu).`);
            return res.status(200).send('Skipped (canceled)');
        }

        const qbo = await getQboInstance();
        const realmId = qbo.realmId;

        const result = await upsertQboInvoice(qbo, so, realmId);
        console.log(`🚀 QBO Invoice ${result.action}: ${result.qbo_invoice_id}`);
        res.status(200).json({ ok: true, ...result });
    } catch (error) {
        console.error('❌ Jubelio → QBO error:', error.message);
        // 500 → Jubelio akan retry (up to 3x per docs)
        res.status(500).send(`Error: ${error.message}`);
    }
});

// ─── Webhook: Faktur / Invoice (create, edit, delete) ───
// Jubelio payload is minimal: { action, invoice_id, invoice_no, ref_no }
// ref_no = salesorder_no (link back to the SO already synced via /pesanan).
// Primary sync happens on /pesanan; /faktur mostly acknowledges, but handles
// delete by voiding the mapped QBO Invoice so QBO stays in sync.
router.post('/faktur', async (req, res) => {
    if (!verifyJubelioSignature(req)) return res.status(401).send('Unauthorized');

    const { action, invoice_no, ref_no } = req.body || {};
    console.log(`📄 Jubelio /faktur: action=${action} invoice=${invoice_no} ref=${ref_no}`);

    const isDelete = typeof action === 'string' && /delete/i.test(action);
    if (!isDelete) {
        return res.status(200).json({ ok: true, acknowledged: true });
    }

    if (!ref_no) {
        console.warn('⚠️ Faktur delete tanpa ref_no — skip.');
        return res.status(200).send('Skipped (no ref_no)');
    }

    try {
        const mapping = await JubelioOrderMap.findOne({ salesorder_no: ref_no });
        if (!mapping) {
            console.log(`ℹ️ Tidak ada mapping QBO untuk SO ${ref_no} — nothing to void.`);
            return res.status(200).send('No mapping');
        }

        const qbo = await getQboInstance();
        const current = await qboGetInvoice(qbo, mapping.qbo_invoice_id);
        await qboUpdateInvoice(qbo, {
            Id: mapping.qbo_invoice_id,
            SyncToken: current.SyncToken,
            sparse: true,
            PrivateNote: `${current.PrivateNote || ''}\n[VOIDED] Jubelio Faktur ${invoice_no} deleted @ ${new Date().toISOString()}`.trim(),
        });
        await JubelioOrderMap.updateOne(
            { salesorder_no: ref_no },
            { last_status: 'VOIDED', last_synced_at: new Date() }
        );
        console.log(`🗑️ QBO Invoice ${mapping.qbo_invoice_id} ditandai VOIDED (SO ${ref_no}).`);
        res.status(200).json({ ok: true, voided: mapping.qbo_invoice_id });
    } catch (error) {
        console.error('❌ /faktur delete error:', error.message);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// ─── Health ───
router.get('/ping', (_req, res) => res.json({ ok: true, integration: 'jubelio-qbo' }));

module.exports = router;
