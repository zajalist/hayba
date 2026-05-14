// Fails the build if required runtime env vars are missing.
// These get substituted into website/config.js via envsubst.
const required = ['VERCEL_PUBLIC_HAYBA_API_URL', 'VERCEL_PUBLIC_HAYBA_ANON_KEY'];
const missing = required.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length > 0) {
  console.error(`\n✗ build aborted — missing required env vars:\n  - ${missing.join('\n  - ')}\n`);
  console.error('Set them in Vercel project settings or your local .env then retry.\n');
  process.exit(1);
}
console.log('✓ env vars present');
