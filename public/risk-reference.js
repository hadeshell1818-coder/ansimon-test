(function(root){
 function conciseReferences(text){return String(text||'').split(/\r?\n/).map(line=>line.replace(/\s*·\s*(?:법제처|국가법령정보센터).*$/,'').replace(/\s*·?\s*https?:\/\/\S+.*$/,'').trim()).filter(Boolean).join('\n')}
 function searchableEvidence(d){return (d.evidence||[]).filter(item=>{
  if(['rejected','unavailable'].includes(item.status))return false;
  if(/^doc:|^sif:/.test(item.ref||''))return item.status==='approved';
  try{const u=new URL(item.sourceUrl);return /^https?:$/.test(u.protocol)&&/^(?:[^.]+\.)*(?:law\.go\.kr|kosha\.or\.kr|moel\.go\.kr|korea\.kr|koreapost\.go\.kr)$/.test(u.hostname)}catch{return false}
 })}
 // Notices, guidelines and standards count only when their text comes from the official law service.
 function officialLawSource(item){try{return /^(?:[^.]+\.)*law\.go\.kr$/.test(new URL(item.sourceUrl).hostname)}catch{return false}}
 function legalReferences(d){return [...new Set(searchableEvidence(d).flatMap(item=>{
  const title=conciseReferences(item.title||''),locator=String(item.locator||'');
  const clause=(title+' '+locator).match(/제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*\([^)]*\))?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?/);
  // Technical standards such as NFTC cite numbered sections ("2.1.1") instead of articles.
  if(!clause&&officialLawSource(item)&&/(?:기준|지침)/.test(title)){const section=locator.match(/^\d+(?:\.\d+)+/);if(section)return [(title+' '+section[0]).trim()];}
  // Annexes (별표) of laws are cited by their annex number, e.g. "산업안전보건법 시행규칙 별표 7".
  if(!clause&&officialLawSource(item)){const annex=locator.match(/^별표\s*\d+(?:의\d+)?/);if(annex)return [(title.replace(/\s*별표.*$/,'').trim()+' '+annex[0]).trim()];}
  if(!clause||!(/(?:법|시행령|규칙)/.test(title)||(officialLawSource(item)&&/(?:고시|지침|기준)/.test(title))))return [];
  return [(title.replace(/\s*제\s*\d+\s*조.*$/,'').trim()+' '+clause[0]).trim()];
 }))]}
 const api={conciseReferences,searchableEvidence,legalReferences};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RiskReferences=api;
})(globalThis);
