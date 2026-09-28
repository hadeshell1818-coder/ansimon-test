import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const root = path.resolve(import.meta.dirname, '..');
const inputPath = path.join(root, 'local-import', 'postal-hazard-controls-review.json');
const outputDir = path.join(root, 'outputs', 'postal-hazard-controls');
const outputPath = path.join(outputDir, '우편작업_유해위험요인_개선대책_검토본.xlsx');
const previewPath = path.join(outputDir, 'preview.png');

const payload = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const workbook = Workbook.create();
const sheet = workbook.worksheets.add('개선대책 검토');
sheet.showGridLines = false;
sheet.tabColor = '#B4232C';

sheet.getRange('A2:J2').merge();
sheet.getRange('A2').values = [[payload.title]];
sheet.getRange('A2:J2').format = {
  font: { name: 'Arial', size: 15, bold: true, color: '#172B4D' },
  verticalAlignment: 'center',
};
sheet.getRange('A2:J2').format.rowHeight = 26;

sheet.getRange('A3:J3').merge();
sheet.getRange('A3').values = [[`${payload.status} · ${payload.record_count.toLocaleString('ko-KR')}개 점검항목`]];
sheet.getRange('A3:J3').format = {
  font: { name: 'Arial', size: 10, color: '#6B7280', italic: true },
  verticalAlignment: 'center',
};

const headers = ['작업명·공정', '번호', '점검 항목', '유해·위험요인', '예상 사고 형태', '개선대책', '추가 보완 제안', '관련 법령·지침', '검색용 핵심어·유사어', '자료 출처·원문 판정'];
const rows = payload.records.map(record => [
  record.task,
  record.item_no,
  record.check_item,
  record.hazard,
  record.accident_type,
  record.controls.map((control, index) => `${index + 1}. ${control}`).join('\n'),
  (record.supplementary_controls || []).map((control, index) => `${index + 1}. ${control}`).join('\n'),
  record.legal_basis.join('\n'),
  record.keywords.join(', '),
  [record.source, record.source_judgement, record.source_rating].filter(Boolean).join('\n'),
]);

sheet.getRange('A5:J5').values = [headers];
sheet.getRangeByIndexes(5, 0, rows.length, headers.length).values = rows;
const endRow = rows.length + 5;
const table = sheet.tables.add(`A5:J${endRow}`, true, 'PostalHazardControls');
table.style = 'TableStyleMedium2';
table.showBandedColumns = false;
table.showFilterButton = true;

sheet.getRange(`A5:J${endRow}`).format.font = { name: 'Arial', size: 10, color: '#1F2937' };
sheet.getRange('A5:J5').format = {
  fill: '#172B4D',
  font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  wrapText: true,
};
sheet.getRange(`A6:J${endRow}`).format.verticalAlignment = 'top';
sheet.getRange(`A6:J${endRow}`).format.wrapText = true;
sheet.getRange(`B6:B${endRow}`).format.horizontalAlignment = 'center';
sheet.getRange(`A6:B${endRow}`).format.verticalAlignment = 'center';
sheet.getRange(`A6:J${endRow}`).format.rowHeight = 72;

sheet.getRange(`A1:A${endRow}`).format.columnWidth = 23;
sheet.getRange(`B1:B${endRow}`).format.columnWidth = 8;
sheet.getRange(`C1:C${endRow}`).format.columnWidth = 58;
sheet.getRange(`D1:D${endRow}`).format.columnWidth = 30;
sheet.getRange(`E1:E${endRow}`).format.columnWidth = 27;
sheet.getRange(`F1:F${endRow}`).format.columnWidth = 72;
sheet.getRange(`G1:G${endRow}`).format.columnWidth = 52;
sheet.getRange(`H1:H${endRow}`).format.columnWidth = 36;
sheet.getRange(`I1:I${endRow}`).format.columnWidth = 42;
sheet.getRange(`J1:J${endRow}`).format.columnWidth = 38;
sheet.freezePanes.freezeRows(5);
sheet.freezePanes.freezeColumns(2);

workbook.recalculate();

const inspection = await workbook.inspect({
  kind: 'table',
  range: '개선대책 검토!A1:J12',
  include: 'values,formulas',
  tableMaxRows: 12,
  tableMaxCols: 10,
  maxChars: 8000,
});
const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
});

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({
  sheetName: '개선대책 검토',
  range: 'A1:J14',
  scale: 1,
  format: 'png',
});
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({ outputPath, previewPath, inspection: inspection.ndjson, errors: errors.ndjson }, null, 2));
