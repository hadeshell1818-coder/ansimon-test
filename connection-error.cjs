// Network failures surface as a bare "fetch failed"; name the service and the likely cause instead.
function connectionFailure(service, error, hint = '') {
  const code = String(error?.cause?.code || error?.code || error?.name || '');
  const reason = /ENOTFOUND|EAI_AGAIN/.test(code) ? '서버 주소를 찾을 수 없습니다(주소 오타 또는 프로젝트 삭제)'
    : /ECONNREFUSED|ECONNRESET|EPIPE/.test(code) ? '서버가 연결을 거부하거나 끊었습니다'
    : /Timeout|Abort|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/.test(code) ? '응답 시간이 초과되었습니다'
    : /CERT|SSL|TLS/.test(code) ? '보안 인증서 확인에 실패했습니다'
    : '네트워크 연결에 실패했습니다';
  const failure = new Error(`${service} 연결 실패 · ${reason}${code ? ` (${code})` : ''}${hint ? ' · ' + hint : ''}`);
  failure.code = 'connection_failed';
  failure.stage = service;
  return failure;
}

module.exports = { connectionFailure };
