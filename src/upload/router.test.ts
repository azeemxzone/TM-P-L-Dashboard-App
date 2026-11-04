import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { routeUploadedFile } from './router';

function findSampleFile(token: string): string {
  const dirs = [
    '/samples',
    path.resolve(process.cwd(), 'samples'),
    path.resolve(__dirname, '../../samples'),
  ];
  const normToken = token.toLowerCase().replace(/[\s_-]+/g, '');

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir);
    const matched = entries.filter((e) => {
      const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '');
      if (normToken === 'tcssales') {
        return normEntry.includes('tcssales') && !normEntry.includes('return');
      }
      if (normToken === 'tcssalesreturn') {
        return (
          normEntry.includes('tcssalesreturn') ||
          (normEntry.includes('tcssales') && normEntry.includes('return'))
        );
      }
      return normEntry.includes(normToken);
    });

    if (matched.length === 1) {
      return path.join(dir, matched[0]);
    }
  }

  throw new Error(`Sample file missing for token: ${token}`);
}

describe('STAGE 4c-1: Unified Smart Drop Zone File Routing with Real Sample Files', () => {
  const selectedMonth = '2026-09';
  const alternativeMonth = '2026-10';

  it('routes Flipkart Orders to marketplace: flipkart, type: orders, period: 2026-09', () => {
    const filePath = findSampleFile('7 Orders');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('flipkart');
    expect(res.type).toBe('orders');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
    expect(res.isGstStage).toBe(false);
  });

  it('routes Flipkart Settled Transaction to marketplace: flipkart, type: settled, period: 2026-09', () => {
    const filePath = findSampleFile('2 Settled Transaction');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('flipkart');
    expect(res.type).toBe('settled');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
  });

  it('routes Flipkart Returns to marketplace: flipkart, type: returns, uses the selected month', () => {
    const filePath = findSampleFile('3 Return');
    const buffer = fs.readFileSync(filePath);

    // With selectedMonth = 2026-09
    const res1 = routeUploadedFile(buffer, selectedMonth);
    expect(res1.marketplace).toBe('flipkart');
    expect(res1.type).toBe('returns');
    expect(res1.period).toBe('2026-09');
    expect(res1.status).toBe('ready');

    // With alternativeMonth = 2026-10 (returns files adopt selected month)
    const res2 = routeUploadedFile(buffer, alternativeMonth);
    expect(res2.marketplace).toBe('flipkart');
    expect(res2.type).toBe('returns');
    expect(res2.period).toBe('2026-10');
  });

  it('routes bank statement SEP_2026 to marketplace: bank, type: bank_statement, period: 2026-09', () => {
    const filePath = findSampleFile('SEP_2026');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('bank');
    expect(res.type).toBe('bank_statement');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
  });

  it('routes Amazon Unified to marketplace: amazon, type: amazon_unified, period: 2026-09', () => {
    const filePath = findSampleFile('MonthlyUnifiedTransaction');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('amazon');
    expect(res.type).toBe('amazon_unified');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
  });

  it('routes Amazon MTR to marketplace: amazon, type: amazon_mtr, period: 2026-09', () => {
    const filePath = findSampleFile('MTR_B2C-SEPTEMBER-2026');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('amazon');
    expect(res.type).toBe('amazon_mtr');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
  });

  it('routes Meesho Orders to marketplace: meesho, type: meesho_orders, period: 2026-09', () => {
    const filePath = findSampleFile('Orders_2026-09-01_2026-09-30');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('meesho');
    expect(res.type).toBe('meesho_orders');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
  });

  it('routes Meesho Returns Delivered to marketplace: meesho, type: meesho_returns_completed, uses selected month', () => {
    const filePath = findSampleFile('Return completed_delivered');
    const buffer = fs.readFileSync(filePath);

    const res1 = routeUploadedFile(buffer, selectedMonth);
    expect(res1.marketplace).toBe('meesho');
    expect(res1.type).toBe('meesho_returns_completed');
    expect(res1.period).toBe('2026-09');
    expect(res1.status).toBe('ready');

    const res2 = routeUploadedFile(buffer, alternativeMonth);
    expect(res2.marketplace).toBe('meesho');
    expect(res2.type).toBe('meesho_returns_completed');
    expect(res2.period).toBe('2026-10');
  });

  it('routes Meesho Returns In Transit to marketplace: meesho, type: meesho_returns_in_transit, uses selected month, optional', () => {
    const filePath = findSampleFile('intransit');
    const buffer = fs.readFileSync(filePath);

    const res = routeUploadedFile(buffer, selectedMonth);
    expect(res.marketplace).toBe('meesho');
    expect(res.type).toBe('meesho_returns_in_transit');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
    expect(res.isOptional).toBe(true);
  });

  it('routes Meesho Payments to marketplace: meesho, type: meesho_payments, period: 2026-09', () => {
    const filePath = findSampleFile('PREVIOUS_PAYMENT');
    const buffer = fs.readFileSync(filePath);
    const res = routeUploadedFile(buffer, selectedMonth);

    expect(res.marketplace).toBe('meesho');
    expect(res.type).toBe('meesho_payments');
    expect(res.period).toBe('2026-09');
    expect(res.status).toBe('ready');
  });

  it('routes the three Meesho GST files and Amazon GSTR1 as "GST stage"', () => {
    // 1. Amazon GSTR1
    const gstr1Path = findSampleFile('GSTR1-SEPTEMBER-2026');
    const gstr1Res = routeUploadedFile(fs.readFileSync(gstr1Path), selectedMonth);
    expect(gstr1Res.marketplace).toBe('amazon');
    expect(gstr1Res.isGstStage).toBe(true);
    expect(gstr1Res.status).toBe('gst_stage');

    // 2. Meesho Tax invoice details
    const taxInvPath = findSampleFile('Tax_invoice_details');
    const taxInvRes = routeUploadedFile(fs.readFileSync(taxInvPath), selectedMonth);
    expect(taxInvRes.marketplace).toBe('meesho');
    expect(taxInvRes.isGstStage).toBe(true);
    expect(taxInvRes.status).toBe('gst_stage');

    // 3. Meesho TCS sales
    const tcsSalesPath = findSampleFile('tcs_sales');
    const tcsSalesRes = routeUploadedFile(fs.readFileSync(tcsSalesPath), selectedMonth);
    expect(tcsSalesRes.marketplace).toBe('meesho');
    expect(tcsSalesRes.isGstStage).toBe(true);
    expect(tcsSalesRes.status).toBe('gst_stage');

    // 4. Meesho TCS sales return
    const tcsReturnPath = findSampleFile('tcs_sales_return');
    const tcsReturnRes = routeUploadedFile(fs.readFileSync(tcsReturnPath), selectedMonth);
    expect(tcsReturnRes.marketplace).toBe('meesho');
    expect(tcsReturnRes.isGstStage).toBe(true);
    expect(tcsReturnRes.status).toBe('gst_stage');
  });

  it('routes an unrelated file as Unrecognised', () => {
    // sku_master_v3.csv is a reference master file, not a marketplace ingestion report
    const skuMasterPath = findSampleFile('sku_master_v3');
    const res = routeUploadedFile(fs.readFileSync(skuMasterPath), selectedMonth);

    expect(res.marketplace).toBe('unknown');
    expect(res.type).toBe('unknown');
    expect(res.status).toBe('unrecognised');
    expect(res.isGstStage).toBe(false);

    // Arbitrary random text
    const randomRes = routeUploadedFile('Some random note or grocery list\nApples, Oranges\n', selectedMonth);
    expect(randomRes.marketplace).toBe('unknown');
    expect(randomRes.type).toBe('unknown');
    expect(randomRes.status).toBe('unrecognised');
  });
});
