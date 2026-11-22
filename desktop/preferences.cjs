const DEFAULT_PREFERENCES = Object.freeze({
  sendShortcut: 'enter',
  transcriptSize: 'standard',
  density: 'comfortable',
  expandToolDetails: false,
  followOutput: true,
  customInstructions: '',
  maxTokens: 4096,
  maxToolCalls: 12,
});

const choices = {
  sendShortcut: ['enter', 'modifier-enter'],
  transcriptSize: ['small', 'standard', 'large'],
  density: ['comfortable', 'compact'],
  maxTokens: [1024, 4096, 8192],
  maxToolCalls: [4, 12, 24],
};

function valid(key, value) {
  if (Object.hasOwn(choices, key)) return choices[key].includes(value);
  if (key === 'customInstructions') return typeof value === 'string' && value.length <= 2000;
  return (key === 'expandToolDetails' || key === 'followOutput') && typeof value === 'boolean';
}

function normalizePreferences(stored) {
  const next = { ...DEFAULT_PREFERENCES };
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const key of Object.keys(next)) {
      if (Object.hasOwn(stored, key) && valid(key, stored[key])) next[key] = stored[key];
    }
  }
  return next;
}

function updatePreferences(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw TypeError('Expected preference changes.');
  const next = normalizePreferences(current);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(next, key) || !valid(key, value)) throw TypeError('Invalid preference.');
    next[key] = value;
  }
  return next;
}

module.exports = { DEFAULT_PREFERENCES, normalizePreferences, updatePreferences };
