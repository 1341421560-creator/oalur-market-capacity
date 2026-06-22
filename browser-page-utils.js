async function activatePage(page) {
  if (!page) return false;
  let activated = false;
  try {
    await page.bringToFront();
    activated = true;
  } catch (_) {}

  let client = null;
  try {
    client = await page.target().createCDPSession();
    await client.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  } catch (_) {
  } finally {
    if (client) await client.detach().catch(() => {});
  }

  try {
    await page.evaluate(() => window.focus());
  } catch (_) {}

  return activated;
}

module.exports = { activatePage };
