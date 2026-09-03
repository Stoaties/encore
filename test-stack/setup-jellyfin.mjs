// One-time setup of the throwaway test Jellyfin: startup wizard, users, music library.
// Usage: node setup-jellyfin.mjs
const JF = process.env.JF_URL ?? 'http://localhost:8096';
const AUTH_HEADER = 'MediaBrowser Client="EncoreSetup", Device="setup", DeviceId="encore-setup", Version="0.1.0"';

const ADMIN = { user: 'admin', pass: 'testpass' };
const USER = { user: 'stoat', pass: 'testpass' };

async function jf(method, path, { token, body, raw } = {}) {
  const headers = { Authorization: token ? `${AUTH_HEADER}, Token="${token}"` : AUTH_HEADER };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${JF}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !raw) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function waitFor(desc, fn, { tries = 60, delayMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Timed out waiting for: ${desc}`);
}

console.log(`Waiting for Jellyfin at ${JF} ...`);
const info = await waitFor('jellyfin up', () => jf('GET', '/System/Info/Public'));
console.log(`Jellyfin ${info.Version} up. Wizard completed: ${info.StartupWizardCompleted}`);

if (!info.StartupWizardCompleted) {
  await jf('POST', '/Startup/Configuration', { body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' } });
  await jf('GET', '/Startup/User');
  await jf('POST', '/Startup/User', { body: { Name: ADMIN.user, Password: ADMIN.pass } });
  await jf('POST', '/Startup/RemoteAccess', { body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
  await jf('POST', '/Startup/Complete');
  console.log('Startup wizard completed.');
}

const auth = await jf('POST', '/Users/AuthenticateByName', { body: { Username: ADMIN.user, Pw: ADMIN.pass } });
const token = auth.AccessToken;
console.log(`Authenticated as ${ADMIN.user} (admin=${auth.User.Policy.IsAdministrator})`);

const users = await jf('GET', '/Users', { token });
if (!users.some((u) => u.Name === USER.user)) {
  await jf('POST', '/Users/New', { token, body: { Name: USER.user, Password: USER.pass } });
  console.log(`Created user ${USER.user}`);
}

const folders = await jf('GET', '/Library/VirtualFolders', { token });
if (!folders.some((f) => f.Name === 'Music')) {
  await jf('POST', '/Library/VirtualFolders?name=Music&collectionType=music&refreshLibrary=true', {
    token,
    body: { LibraryOptions: { PathInfos: [{ Path: '/music' }], EnableRealtimeMonitor: false } },
  });
  console.log('Created Music library at /music, scan started.');
}

const total = await waitFor('library scan (>= 18 tracks)', async () => {
  const r = await jf('GET', `/Items?IncludeItemTypes=Audio&Recursive=true&Limit=0&userId=${auth.User.Id}`, { token });
  console.log(`  indexed so far: ${r.TotalRecordCount}`);
  return r.TotalRecordCount >= 18 ? r.TotalRecordCount : null;
});
console.log(`Done. Library has ${total} tracks. Users: ${ADMIN.user}/${ADMIN.pass} (admin), ${USER.user}/${USER.pass}.`);
