'use strict';

const { AppServerClient, findCodexPath } = require('./server');

async function main() {
  const client = new AppServerClient({ requestTimeoutMs: 20000 });
  try {
    await client.start();
    const threads = await client.request('thread/list', {
      limit: 5,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    const account = await client.request('account/read', { refreshToken: false });
    const rateLimits = await client.request('account/rateLimits/read');
    const data = Array.isArray(threads && threads.data) ? threads.data : [];
    const rate = rateLimits && rateLimits.rateLimits ? rateLimits.rateLimits : {};
    const primary = rate.primary || null;
    const secondary = rate.secondary || null;
    const credits = rate.credits || null;
    const plan = (account && account.account && account.account.planType) || rate.planType || 'unknown';
    console.log('SMOKE_PASS');
    console.log(`codex: ${findCodexPath() || 'not-found'}`);
    console.log(`thread/list: ${data.length} threads returned`);
    console.log(`account/read: plan=${plan}`);
    console.log(`account/rateLimits/read: primary.usedPercent=${primary && primary.usedPercent !== undefined ? primary.usedPercent : 'unavailable'}, secondary.usedPercent=${secondary && secondary.usedPercent !== undefined ? secondary.usedPercent : 'unavailable'}`);
    console.log(`account/rateLimits/read: primary.windowDurationMins=${primary && primary.windowDurationMins !== undefined ? primary.windowDurationMins : 'unavailable'}, primary.resetsAt=${primary && primary.resetsAt !== undefined ? 'present' : 'unavailable'}, credits=${credits && credits.balance !== undefined ? 'present' : 'unavailable'}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`SMOKE_FAIL: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});

