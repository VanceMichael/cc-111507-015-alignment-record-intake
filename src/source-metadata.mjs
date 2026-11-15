function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { return { format: 'SAM', declarations: bytes.toString().split('\n').filter(line => line.startsWith('@')).length }; }
