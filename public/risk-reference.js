(function(root){
 function conciseReferences(text){return String(text||'').split(/\r?\n/).map(line=>line.replace(/\s*·\s*(?:법제처|국가법령정보센터).*$/,'').replace(/\s*·?\s*https?:\/\/\S+.*$/,'').trim()).filter(Boolean).join('\n')}
 function searchableEvidence(d){return (d.evidence||[]).filter(item=>{
  if(['rejected','unavailable'].includes(item.status))return false;
  if(/^doc:|^sif:/.test(item.ref||''))return item.status==='approved';
  try{const u=new URL(item.sourceUrl);return /^https?:$/.test(u.protocol)&&/^(?:[^.]+\.)*(?:law\.go\.kr|kosha\.or\.kr|moel\.go\.kr|korea\.kr|koreapost\.go\.kr)$/.test(u.hostname)}catch{return false}
 })}
 function legalReferences(d){return [...new Set(searchableEvidence(d).flatMap(item=>{
  const title=conciseReferences(item.title||''),locator=String(item.locator||'');
  const clause=(title+' '+locator).match(/제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*\([^)]*\))?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?/);
  if(!clause||!/(?:법|시행령|규칙)/.test(title))return [];
  return [(title.replace(/\s*제\s*\d+\s*조.*$/,'').trim()+' '+clause[0]).trim()];
 }))]}
 const api={conciseReferences,searchableEvidence,legalReferences};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RiskReferences=api;
})(globalThis);
