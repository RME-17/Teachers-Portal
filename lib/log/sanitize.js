// Sanitize log output to avoid leaking secrets from environment or URLs.
// Exports sanitizeArgs(...args) -> string

const ENV_KEYS = Object.keys(process.env || {});
const SECRET_KEY_REGEX = /(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|AUTH|BEARER|CREDENTIAL|PRIVATE)/i;

function _maskEnvValues(s) {
  if (!s || typeof s !== 'string') return s;
  let out = s;

  // Replace explicit query param secrets like client_secret=..., api_key=..., token=...
  out = out.replace(/(client_secret)=([^&\s]+)/gi, (m, k) => `${k}=[REDACTED]`);
  out = out.replace(/(api_key)=([^&\s]+)/gi, (m, k) => `${k}=[REDACTED]`);
  out = out.replace(/(access_token)=([^&\s]+)/gi, (m, k) => `${k}=[REDACTED]`);
  out = out.replace(/(auth_token)=([^&\s]+)/gi, (m, k) => `${k}=[REDACTED]`);
  out = out.replace(/(token)=([^&\s]+)/gi, (m, k) => `${k}=[REDACTED]`);

  // Mask Authorization: Bearer <token>
  out = out.replace(/(Authorization:\s*Bearer)\s+[^\s]+/gi, '$1 [REDACTED]');
  out = out.replace(/(Bearer)\s+[^\s]+/gi, '$1 [REDACTED]');

  // Only mask environment variable values for keys that look secret-like.
  // This prevents accidental masking of common small values like 0 or 1.
  const keys = ENV_KEYS.slice().sort((a, b) => b.length - a.length);
  for (const k of keys) {
    try {
      if (!SECRET_KEY_REGEX.test(k)) continue; // skip non-secret keys
      const v = process.env[k];
      if (!v || typeof v !== 'string') continue;
      if (v.length === 0) continue;
      // Only attempt replace when the value is present in the string
      if (out.indexOf(v) !== -1) {
        const placeholder = `${k}=${process.env[k] ? '[set]' : '[missing]'}`;
        out = out.split(v).join(placeholder);
      }
    } catch (e) {
      // defensive: ignore errors for odd env values
    }
  }

  // Generic long-secret masking: replace long base64-like tokens (>=40 chars of [A-Za-z0-9_\-\.=])
  out = out.replace(/([A-Za-z0-9_\-\.=]{40,})/g, '[REDACTED_LONG_TOKEN]');

  return out;
}

function sanitizeArgs(args) {
  try {
    const parts = (Array.isArray(args) ? args : [args]).map((a) => {
      if (typeof a === 'string') return _maskEnvValues(a);
      try {
        return _maskEnvValues(JSON.stringify(a));
      } catch (e) {
        return String(a);
      }
    });
    return parts.join(' ');
  } catch (e) {
    try { return String(args); } catch { return '[unprintable]'; }
  }
}

module.exports = { sanitizeArgs };
