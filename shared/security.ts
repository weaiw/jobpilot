export function redactSensitive(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, 'sk-***')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/((?:api[_ -]?key|token|secret)[^:=\n]{0,24}[:=]\s*)[^\s,"'}]+/gi, '$1***')
    .replace(/("Authorization"\s*:\s*")[^"]+/gi, '$1***')
}
