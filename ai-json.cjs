// Shared bounded JSON handling. Never writes application records or retries a POST that saves data.
function aiFailure(code, stage, message) {
  const error = new Error(`${stage}: ${message}`);
  error.code = code;
  error.stage = stage;
  return error;
}

async function requestAiJson({ request = fetch, key, messages, maxTokens = 2000, stage = 'AI 작성', timeoutMs = 25000 }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await request('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', response_format: { type: 'json_object' },
          max_tokens: attempt ? Math.min(maxTokens * 2, 6000) : maxTokens, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_) {
      throw aiFailure('ai_connection_failed', stage, 'AI 연결이 지연되거나 끊겼습니다. 입력 내용은 유지됩니다. 잠시 후 다시 시도하거나 직접 작성해 주세요.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw aiFailure('ai_service_failed', stage, `AI 서비스 요청 실패 (${response.status}). 서버의 인증·모델 설정 또는 사용 한도를 확인해 주세요.`);
    }
    const choice = result?.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
      throw aiFailure('ai_response_refused', stage, 'AI가 답변을 제공하지 못했습니다. 원본을 확인해 직접 작성해 주세요.');
    }
    if (choice?.finish_reason !== 'length') {
      try {
        const parsed = JSON.parse(choice?.message?.content || '');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) return parsed;
      } catch (_) { /* Retry only malformed or truncated model output, once. */ }
    }
  }
  throw aiFailure('ai_invalid_response', stage, 'AI 응답이 잘렸거나 형식이 올바르지 않습니다. 입력 내용은 유지됩니다. 다시 시도하거나 직접 작성해 주세요.');
}

module.exports = { requestAiJson, aiFailure };
