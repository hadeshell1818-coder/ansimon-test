const XLSX = require('xlsx-js-style');
const {conciseReferences}=require('./public/risk-reference.js');
const WIDTHS = [5, 23, 10, 30, 12, 12, 10, 11, 24];
function wrapLines(value, width) {
  const lines = [];
  for (const line of String(value ?? '').split(/\r?\n/)) {
    let text = '', units = 0;
    for (const char of line) {
      const size = char.codePointAt(0) > 255 ? 2 : 1;
      if (units + size > width && text) { lines.push(text); text = ''; units = 0; }
      text += char; units += size;
    }
    lines.push(text);
  }
  return lines;
}
function exportRows(items) {
  const rows = [], heights = [];
  for (const [index, it] of items.entries()) {
    const values = [index + 1, it.factor || '', it.riskLevel || '', it.reduction || '', it.dueDate || '', it.completedDate || (it.doneAt ? it.doneAt.slice(0, 10) : ''), it.owner || '', it.doneAt || it.resultUpdatedAt ? '작성 완료' : '미작성', conciseReferences(it.referenceText)];
    const cells = values.map((value, column) => wrapLines(value, WIDTHS[column] - 2));
    const maxLines = Math.max(...cells.map(lines => lines.length));
    for (let offset = 0; offset < maxLines; offset += 18) {
      rows.push(cells.map((lines, column) => [1, 3, 8].includes(column) ? lines.slice(offset, offset + 18).join('\n') : (offset ? (column === 0 ? `${index + 1} (계속)` : values[column]) : values[column])));
      heights.push(Math.min(18, maxLines - offset) * 15 + 10);
    }
  }
  return { rows, heights };
}
function configureExport(buffer) {
  const zip = XLSX.CFB.read(buffer, { type: 'buffer' });
  for (let i = 0; i < zip.FullPaths.length; i++) {
    const entry = zip.FileIndex[i];
    if (!/xl\/worksheets\/sheet\d+\.xml$/.test(zip.FullPaths[i])) continue;
    let xml = entry.content.toString('utf8');
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, '').replace(/<dimension\b[^>]*\/>/, '$&<sheetViews><sheetView workbookViewId="0" zoomScale="100" zoomScaleNormal="100"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    xml = xml.replace(/<pageMargins\b[^>]*\/>|<pageSetup\b[^>]*\/>/g, '').replace('</worksheet>', '<pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>');
    xml = xml.replace(/<sheetPr\s*\/>/, '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    if (!xml.includes('<sheetPr')) xml = xml.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    entry.content = Buffer.from(xml); entry.size = entry.content.length;
  }
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' });
}
module.exports = { WIDTHS, exportRows, configureExport };
