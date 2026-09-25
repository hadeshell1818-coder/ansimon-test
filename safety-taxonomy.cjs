// Search labels are derived hints; the original source fields remain unchanged.
const groups = {
  equipment: {
    '운반대차': ['롤파렛트', '롤파레트', '롤테이너', '대차', '카트', '핸드파렛트'],
    '컨베이어': ['컨베이어', '컨베어', '구분기'],
    '지게차': ['지게차'],
    '승강설비': ['리프트', '승강기'],
    '사다리': ['사다리'],
    '차량': ['화물차', '화물자동차', '트럭', '이륜차', '자동차'],
  },
  work: {
    '상하차·운반': ['상차', '하차', '하역', '운반', '적재', '운송'],
    '설비 점검·정비': ['점검', '정비', '보수', '수리', '청소'],
    '시설·공사': ['굴착', '공사', '비계', '지붕', '도장'],
    '중량물 취급': ['중량물', '인력운반', '들어 올리'],
  },
  hazard: {
    '끼임': ['끼임', '끼여', '협착', '말려'],
    '추락': ['추락', '떨어짐', '떨어져'],
    '넘어짐·전도': ['넘어', '전도', '미끄러'],
    '충돌·깔림': ['충돌', '부딪', '깔림', '깔려'],
    '감전': ['감전'],
    '화재·폭발': ['화재', '폭발'],
    '유해물질·질식': ['질식', '중독', '유해물질', '산소결핍'],
    '근골격계 부담': ['근골격', '요통', '허리', '반복작업'],
  },
};
function classify(row) {
  const body = [row.incident_summary, row.hazard_object, row.high_risk_situation, row.causal_factors].join(' ');
  return Object.fromEntries(Object.entries(groups).map(([group, labels]) => [group,
    Object.entries(labels).filter(([, words]) => words.some(word => body.includes(word))).map(([label]) => label),
  ]));
}
module.exports = { classify };
