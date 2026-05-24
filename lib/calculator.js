function calculate(expression) {
  const expr = typeof expression === 'string' ? expression.trim() : '';
  // Only allow digits, operators, parentheses, decimal point and spaces
  if (!/^[0-9+\-*/().\s]+$/.test(expr) || expr.length === 0) {
    return { ok: false, error: 'INVALID_EXPRESSION', expression };
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('return (' + expr + ')')();
    if (typeof result !== 'number' || !isFinite(result)) {
      return { ok: false, error: 'NON_NUMERIC_RESULT', expression };
    }
    return { ok: true, expression: expr, result };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'EVAL_ERROR', expression };
  }
}

module.exports = { calculate };
