const XLSX = require('xlsx');

const SIF_SOURCE_URL = 'https://www.data.go.kr/data/15140383/fileData.do';
const SIF_TITLE = '산업재해 고위험요인(SIF) 아카이브';
const SIF_PUBLISHER = '한국산업안전보건공단';

function text(value) {
  return value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

function asRaw(values, labels) {
  return labels.reduce((row, label, index) => {
    row[label] = text(values[index]);
    return row;
  }, {});
}

function parseSifWorkbook(buffer, fileName = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: false });
  const rows = [];
  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const isConstruction = sheetName.includes('건설업');
    const isManufacturing = sheetName.includes('제조업');
    if (!isConstruction && !isManufacturing) continue;
    sheets.push(sheetName);

    const start = isConstruction ? 4 : 3;
    for (let index = start; index < matrix.length; index += 1) {
      const values = matrix[index] || [];
      // SheetJS omits the visually empty first worksheet column, so 연번 is index 0.
      const number = text(values[0]);
      if (!number || !/^\d+$/.test(number)) continue;
      const excelRow = index + 1;
      if (isConstruction) {
        const raw = asRaw(values.slice(0, 9), [
          '연번', '공종', '작업명', '단위작업명', '재해종류', '재해개요', '기인물', '재해유발요인', '위험성 감소대책(예시)',
        ]);
        rows.push({
          source_file: fileName,
          source_sheet: sheetName,
          source_row: excelRow,
          domain: 'construction',
          industry_large: '건설업',
          industry_medium: '',
          industry_small: '',
          work_category: raw.공종,
          work_name: raw.작업명,
          unit_work: raw.단위작업명,
          incident_type: raw.재해종류,
          incident_summary: raw.재해개요,
          hazard_object: raw.기인물,
          high_risk_situation: [raw.공종, raw.작업명, raw.단위작업명].filter(Boolean).join(' > '),
          causal_factors: raw.재해유발요인,
          reduction_measures: raw['위험성 감소대책(예시)'],
          raw_row: raw,
        });
      } else {
        const raw = asRaw(values.slice(0, 9), [
          '연번', '산재업종(대분류)', '산재업종(중분류)', '산재업종(소분류)', '재해개요', '기인물', '고위험작업·상황', '재해유발요인', '위험성 감소대책(예시)',
        ]);
        rows.push({
          source_file: fileName,
          source_sheet: sheetName,
          source_row: excelRow,
          domain: 'manufacturing',
          industry_large: raw['산재업종(대분류)'],
          industry_medium: raw['산재업종(중분류)'],
          industry_small: raw['산재업종(소분류)'],
          work_category: raw['고위험작업·상황'],
          work_name: '',
          unit_work: '',
          incident_type: '',
          incident_summary: raw.재해개요,
          hazard_object: raw.기인물,
          high_risk_situation: raw['고위험작업·상황'],
          causal_factors: raw.재해유발요인,
          reduction_measures: raw['위험성 감소대책(예시)'],
          raw_row: raw,
        });
      }
    }
  }
  if (!rows.length) throw new Error('제조업 등 또는 건설업 SIF 시트를 찾지 못했습니다. 원본 엑셀을 확인하세요.');
  return { rows, sheets, source_url: SIF_SOURCE_URL, title: SIF_TITLE, publisher: SIF_PUBLISHER };
}

module.exports = { parseSifWorkbook, SIF_SOURCE_URL, SIF_TITLE, SIF_PUBLISHER };
