import * as XLSX from 'xlsx';

/**
 * Recomputes ws["!ref"] from actual cell addresses in the sheet by scanning cell keys.
 * Fixes truncated ranges in workbooks that have no default style or a bad dimension.
 */
export function fixSheetRef(ws: XLSX.WorkSheet | undefined): void {
  if (!ws) return;
  const keys = Object.keys(ws).filter((k) => !k.startsWith('!'));
  if (keys.length === 0) return;
  let minR = Infinity;
  let maxR = -1;
  let minC = Infinity;
  let maxC = -1;
  for (const k of keys) {
    const cell = XLSX.utils.decode_cell(k);
    if (cell.r < minR) minR = cell.r;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c < minC) minC = cell.c;
    if (cell.c > maxC) maxC = cell.c;
  }
  if (maxR >= 0 && maxC >= 0 && minR !== Infinity && minC !== Infinity) {
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
  }
}

/**
 * Applies fixSheetRef to every sheet in the workbook.
 */
export function fixWorkbookRefs(wb: XLSX.WorkBook | undefined): void {
  if (!wb || !wb.SheetNames) return;
  for (const name of wb.SheetNames) {
    fixSheetRef(wb.Sheets[name]);
  }
}
