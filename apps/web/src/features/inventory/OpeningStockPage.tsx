import type { OpeningStockResult, OpeningStockRow } from '@waretrack/shared-schemas';
import { CheckCircle2, Download, FileUp, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useOpeningStock } from '@/lib/admin-queries';
import { useAuth } from '@/stores/auth';
import { describeError } from '@/lib/api';
import { useSiteContext } from '../shell/SiteShell';

const CSV_HEADER = 'sku,location,quantity,pallet,lot,expires';
const CSV_TEMPLATE = `${CSV_HEADER}\nPKG-BOX-M,A-001,240,,,\nFRZ-PEAS-10,S01,120,PAL-OPEN-0001,L2610-01,2027-06-30\n`;

/** Tách một dòng CSV (hỗ trợ giá trị trong dấu ngoặc kép có dấu phẩy). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let insideQuotes = false;
  for (let position = 0; position < line.length; position++) {
    const character = line[position];
    if (character === '"') {
      if (insideQuotes && line[position + 1] === '"') {
        current += '"';
        position++;
      } else insideQuotes = !insideQuotes;
    } else if (character === ',' && !insideQuotes) {
      cells.push(current.trim());
      current = '';
    } else current += character;
  }
  cells.push(current.trim());
  return cells;
}

/** CSV → dòng tồn đầu kỳ; cột nhận diện theo tiêu đề (sku, location, quantity, pallet, lot, expires). */
function parseOpeningCsv(text: string): { rows: OpeningStockRow[]; problem: string | null } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return { rows: [], problem: 'empty' };
  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const columnOf = (names: string[]) => header.findIndex((cell) => names.includes(cell));
  const skuColumn = columnOf(['sku', 'sku_code', 'skucode']);
  const locationColumn = columnOf(['location', 'location_code', 'locationcode']);
  const quantityColumn = columnOf(['quantity', 'qty']);
  const palletColumn = columnOf(['pallet', 'pallet_code', 'palletcode']);
  const lotColumn = columnOf(['lot', 'lot_number', 'lotnumber']);
  const expiryColumn = columnOf(['expires', 'expires_on', 'expiry', 'expireson']);
  if (skuColumn < 0 || locationColumn < 0 || quantityColumn < 0) return { rows: [], problem: 'header' };
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const optional = (column: number) => (column >= 0 && cells[column] ? cells[column] : undefined);
    return {
      skuCode: cells[skuColumn] ?? '',
      locationCode: cells[locationColumn] ?? '',
      quantity: (cells[quantityColumn] ?? '').replace(/,/g, ''),
      palletCode: optional(palletColumn),
      lotNumber: optional(lotColumn),
      expiresOn: optional(expiryColumn),
    };
  });
  return { rows, problem: null };
}

/**
 * Nhập tồn kho đầu kỳ khi đưa site thật vào hệ thống: dán/tải CSV → kiểm tra (không ghi) → nhập.
 * Có bất kỳ dòng lỗi nào thì không ghi dòng nào (tất cả hoặc không).
 */
export function OpeningStockPage() {
  const { t } = useTranslation();
  const { siteId, siteCode } = useSiteContext();
  const openingStock = useOpeningStock(siteId);
  const [csvText, setCsvText] = useState('');
  const [result, setResult] = useState<OpeningStockResult | null>(null);
  const parsed = useMemo(() => parseOpeningCsv(csvText), [csvText]);
  const canImport = useAuth((state) => state.can(siteId, 'inventory.opening.import'));
  const validated = result?.dryRun === true && result.errorCount === 0;
  const imported = result?.dryRun === false;

  const runImport = (dryRun: boolean) =>
    openingStock.mutate(
      { rows: parsed.rows, dryRun },
      {
        onSuccess: setResult,
      },
    );

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'opening-stock-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!canImport) {
    return (
      <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
        <div className="card mx-auto max-w-xl p-8 text-center text-sm text-muted" data-testid="opening-forbidden">
          {t('opening.forbidden')}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-4 pb-6 pt-[76px]">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t('opening.title', { site: siteCode })}</h1>
            <p className="max-w-2xl text-sm text-muted">{t('opening.subtitle')}</p>
          </div>
          <Button variant="outline" onClick={downloadTemplate}>
            <Download size={15} /> {t('opening.template')}
          </Button>
        </div>

        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">
              <FileUp size={15} /> {t('opening.chooseFile')}
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                data-testid="opening-file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setCsvText(await file.text());
                    setResult(null);
                  }
                }}
              />
            </label>
            <span className="text-xs text-muted">{t('opening.columns', { header: CSV_HEADER })}</span>
          </div>
          <textarea
            className="min-h-40 w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs outline-none focus:border-brand"
            placeholder={CSV_TEMPLATE}
            value={csvText}
            data-testid="opening-csv"
            onChange={(event) => {
              setCsvText(event.target.value);
              setResult(null);
            }}
          />
          {csvText && parsed.problem === 'header' ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{t('opening.badHeader', { header: CSV_HEADER })}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{t('opening.rowsRead', { n: parsed.rows.length })}</span>
            <div className="flex-1" />
            <Button variant="outline" disabled={!parsed.rows.length || openingStock.isPending || imported} onClick={() => runImport(true)} data-testid="validate-opening">
              <CheckCircle2 size={15} /> {t('opening.validate')}
            </Button>
            <Button disabled={!validated || openingStock.isPending} onClick={() => runImport(false)} data-testid="import-opening">
              <Upload size={15} /> {t('opening.import')}
            </Button>
          </div>
          {openingStock.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(openingStock.error)}</p> : null}
        </div>

        {result ? (
          <div className="card p-4" data-testid="opening-result">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {imported ? (
                <Badge tone="ok">{t('opening.imported', { n: result.importedPallets })}</Badge>
              ) : result.errorCount ? (
                <Badge tone="bad">{t('opening.errors', { n: result.errorCount })}</Badge>
              ) : (
                <Badge tone="ok">{t('opening.ready', { n: result.rows.length })}</Badge>
              )}
              {imported ? (
                <Link to={`/sites/${siteCode}/inventory`} className="text-sm font-semibold text-brand underline">
                  {t('opening.viewInventory')}
                </Link>
              ) : null}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">{t('opening.location')}</th>
                  <th className="px-3 py-2 text-right">{t('opening.quantity')}</th>
                  <th className="px-3 py-2">{t('opening.pallet')}</th>
                  <th className="px-3 py-2">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((rowResult) => {
                  const sourceRow = parsed.rows[rowResult.rowNumber - 1];
                  return (
                    <tr key={rowResult.rowNumber} className="border-t border-line">
                      <td className="px-3 py-1.5 text-muted">{rowResult.rowNumber}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{sourceRow?.skuCode}</td>
                      <td className="px-3 py-1.5">{sourceRow?.locationCode}</td>
                      <td className="tabular px-3 py-1.5 text-right">{sourceRow?.quantity}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{rowResult.palletCode ?? t('opening.autoCode')}</td>
                      <td className="px-3 py-1.5">{rowResult.status === 'OK' ? <Badge tone="ok">OK</Badge> : <span className="text-xs text-bad">{rowResult.message}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
