'use strict';

/**
 * Tests unitaires — Verisure Homey App
 * Couvre VerisureClient (auth, parsing, arm/disarm, eventlog) et VerisurePoller (diff, events)
 *
 * Lancer : node test/verisure.test.js
 * (pas de dépendances externes — runner maison léger)
 */

// ─── Mini test runner ────────────────────────────────────────────────────────
let _passed = 0, _failed = 0, _suite = '';
function describe(name, fn) { _suite = name; console.log(`\n◆ ${name}`); fn(); }
async function it(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    _passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    → ${e.message}`);
    _failed++;
  }
}
function expect(val) {
  return {
    toBe: (exp) => { if (val !== exp) throw new Error(`Expected ${JSON.stringify(exp)}, got ${JSON.stringify(val)}`); },
    toEqual: (exp) => { if (JSON.stringify(val) !== JSON.stringify(exp)) throw new Error(`Expected ${JSON.stringify(exp)}, got ${JSON.stringify(val)}`); },
    toBeTruthy: () => { if (!val) throw new Error(`Expected truthy, got ${JSON.stringify(val)}`); },
    toBeFalsy: () => { if (val) throw new Error(`Expected falsy, got ${JSON.stringify(val)}`); },
    toBeNull: () => { if (val !== null) throw new Error(`Expected null, got ${JSON.stringify(val)}`); },
    toBeGreaterThan: (n) => { if (!(val > n)) throw new Error(`Expected ${val} > ${n}`); },
    toContain: (str) => { if (!String(val).includes(str)) throw new Error(`Expected "${val}" to contain "${str}"`); },
    toHaveLength: (n) => { if (val.length !== n) throw new Error(`Expected length ${n}, got ${val.length}`); },
    toThrow: async (msgPart) => {
      try { await val(); throw new Error('Expected function to throw but it did not'); }
      catch (e) { if (msgPart && !e.message.includes(msgPart)) throw new Error(`Expected error "${msgPart}", got "${e.message}"`); }
    },
  };
}

// ─── Mock Homey ──────────────────────────────────────────────────────────────
function makeHomey(settings = {}) {
  const store = { ...settings };
  return {
    settings: {
      get: (k) => store[k] ?? null,
      set: async (k, v) => { store[k] = v; },
      unset: async (k) => { delete store[k]; },
      on: () => {},
      _store: store,
    },
    log: () => {},
    error: () => {},
    notifications: { createNotification: async () => {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };
}

// ─── Mocks réseau (pas de réseau en test) ────────────────────────────────────
// Mock node-fetch
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'node-fetch') {
    return async () => ({ ok: true, status: 200, json: async () => ({}), buffer: async () => Buffer.alloc(0) });
  }
  if (request === 'tough-cookie') {
    class FakeCookieJar {
      toJSON() { return {}; }
      static fromJSON() { return new FakeCookieJar(); }
      getCookieString() { return Promise.resolve(''); }
      setCookie() { return Promise.resolve(null); }
    }
    return { CookieJar: FakeCookieJar };
  }
  if (request === 'https') { return { Agent: class {} }; }
  return _originalLoad.apply(this, arguments);
};

// ─── Load modules ────────────────────────────────────────────────────────────
const path = require('path');
// Adapter le chemin selon où on lance les tests
const LIB = path.resolve(__dirname, '../lib');
const VerisureClient = require(path.join(LIB, 'VerisureClient'));
const VerisurePoller = require(path.join(LIB, 'VerisurePoller'));

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — VerisureClient méthodes statiques
// ════════════════════════════════════════════════════════════════════════════
describe('VerisureClient — méthodes statiques', () => {

  it('toAlarmContact retourne true pour OPEN', async () => {
    expect(VerisureClient.toAlarmContact('OPEN')).toBe(true);
  });

  it('toAlarmContact retourne false pour CLOSE', async () => {
    expect(VerisureClient.toAlarmContact('CLOSE')).toBe(false);
  });

  it('toHomeyAlarmState ARMED_AWAY → armed', async () => {
    expect(VerisureClient.toHomeyAlarmState('ARMED_AWAY')).toBe('armed');
  });

  it('toHomeyAlarmState ARMED_HOME → partially_armed', async () => {
    expect(VerisureClient.toHomeyAlarmState('ARMED_HOME')).toBe('partially_armed');
  });

  it('toHomeyAlarmState ARMED_NIGHT → partially_armed', async () => {
    expect(VerisureClient.toHomeyAlarmState('ARMED_NIGHT')).toBe('partially_armed');
  });

  it('toHomeyAlarmState ARMED_DAY → partially_armed', async () => {
    expect(VerisureClient.toHomeyAlarmState('ARMED_DAY')).toBe('partially_armed');
  });

  it('toHomeyAlarmState DISARMED → disarmed', async () => {
    expect(VerisureClient.toHomeyAlarmState('DISARMED')).toBe('disarmed');
  });

  it('toHomeyAlarmState valeur inconnue → disarmed (défaut)', async () => {
    expect(VerisureClient.toHomeyAlarmState('UNKNOWN_VALUE')).toBe('disarmed');
  });

  it('_protomToStatusType D → DISARMED', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client._protomToStatusType('D')).toBe('DISARMED');
  });

  it('_protomToStatusType T → ARMED_AWAY', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client._protomToStatusType('T')).toBe('ARMED_AWAY');
  });

  it('_protomToStatusType P → ARMED_HOME', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client._protomToStatusType('P')).toBe('ARMED_HOME');
  });

  it('_protomToStatusType N → ARMED_NIGHT', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client._protomToStatusType('N')).toBe('ARMED_NIGHT');
  });

  it('_protomToStatusType valeur inconnue → null', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client._protomToStatusType('X')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — VerisureClient constructor et session
// ════════════════════════════════════════════════════════════════════════════
describe('VerisureClient — constructor et session', () => {

  it('crée une instance sans erreur', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client).toBeTruthy();
  });

  it('_authHash est null par défaut', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    expect(client._authHash).toBeNull();
  });

  it('fromSettings lève une erreur si pas de hash', async () => {
    await expect(async () => {
      VerisureClient.fromSettings({ homey: makeHomey() });
    }).toThrow('Aucune session Verisure');
  });

  it('fromSettings restaure la session depuis les settings', async () => {
    const homey = makeHomey({
      verisure_auth_hash:  'test_jwt_hash',
      verisure_email:      'test@example.com',
      verisure_numinst:    '386019',
      verisure_panel:      'SDVFAST',
      verisure_session_id: 'OWP___test___20263221000000',
      verisure_login_ts:   '1774000000000',
    });
    const client = VerisureClient.fromSettings({ homey });
    expect(client._authHash).toBe('test_jwt_hash');
    expect(client._email).toBe('test@example.com');
    expect(client._numinst).toBe('386019');
    expect(client._panel).toBe('SDVFAST');
  });

  it('_restoreSession restaure correctement tous les champs', async () => {
    const homey = makeHomey({
      verisure_auth_hash:   'hash123',
      verisure_email:       'user@test.fr',
      verisure_giid:        '111222',
      verisure_numinst:     '111222',
      verisure_panel:       'SDVECUW',
      verisure_login_ts:    '1774000000000',
      verisure_session_id:  'OWP___user___20260101120000',
      verisure_capab_token: 'capab_token_xyz',
    });
    const client = new VerisureClient({ homey });
    client._restoreSession();
    expect(client._authHash).toBe('hash123');
    expect(client._email).toBe('user@test.fr');
    expect(client._giid).toBe('111222');
    expect(client._capabToken).toBe('capab_token_xyz');
    expect(client._sessionId).toBe('OWP___user___20260101120000');
  });

  it('_saveSession persiste les valeurs dans les settings', async () => {
    const homey = makeHomey();
    const client = new VerisureClient({ homey });
    client._authHash  = 'saved_hash';
    client._email     = 'saved@test.fr';
    client._giid      = '999';
    client._numinst   = '999';
    client._panel     = 'SDVFAST';
    client._loginTs   = 1774000000000;
    client._sessionId = 'OWP___saved___20260101000000';
    await client._saveSession();
    expect(homey.settings.get('verisure_auth_hash')).toBe('saved_hash');
    expect(homey.settings.get('verisure_email')).toBe('saved@test.fr');
    expect(homey.settings.get('verisure_session_id')).toBe('OWP___saved___20260101000000');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — VerisureClient headers
// ════════════════════════════════════════════════════════════════════════════
describe('VerisureClient — construction des headers', () => {

  it('_fullHeaders contient Content-Type application/json', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash  = 'jwt';
    client._email     = 'test@test.fr';
    client._numinst   = '386019';
    client._panel     = 'SDVFAST';
    client._loginTs   = Date.now();
    client._sessionId = 'OWP___test___20260101000000';
    const h = client._fullHeaders();
    expect(h['Content-Type']).toBe('application/json');
  });

  it('_fullHeaders contient app-origin web', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash  = 'jwt';
    client._email     = 'test@test.fr';
    client._numinst   = '386019';
    client._loginTs   = Date.now();
    client._sessionId = 'OWP___test___20260101000000';
    const h = client._fullHeaders();
    expect(h['app-origin']).toBe('web');
  });

  it('_fullHeaders contient numinst et x-installationNumber', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash  = 'jwt';
    client._email     = 'test@test.fr';
    client._numinst   = '386019';
    client._loginTs   = Date.now();
    client._sessionId = 'OWP___test___20260101000000';
    const h = client._fullHeaders();
    expect(h['numinst']).toBe('386019');
    expect(h['x-installationNumber']).toBe('386019');
  });

  it('_fullHeaders contient x-capabilities si capabToken présent', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash    = 'jwt';
    client._email       = 'test@test.fr';
    client._numinst     = '386019';
    client._loginTs     = Date.now();
    client._sessionId   = 'OWP___test___20260101000000';
    client._capabToken  = 'my_capab_token';
    const h = client._fullHeaders();
    expect(h['x-capabilities']).toBe('my_capab_token');
  });

  it('_authHeader inclut loginTimestamp, user, id, hash', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash  = 'my_jwt';
    client._email     = 'alice@test.fr';
    client._numinst   = '386019';
    client._loginTs   = 1774000000000;
    client._sessionId = 'OWP___alice___20260101000000';
    const h = client._authHeader();
    const authObj = JSON.parse(h['auth']);
    expect(authObj.hash).toBe('my_jwt');
    expect(authObj.user).toBe('alice@test.fr');
    expect(authObj.id).toBe('OWP___alice___20260101000000');
    expect(authObj.loginTimestamp).toBe(1774000000000);
    expect(authObj.country).toBe('FR');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — VerisureClient setArmState validation
// ════════════════════════════════════════════════════════════════════════════
describe('VerisureClient — setArmState validation', () => {

  it('setArmState lève une erreur si pas de code PIN', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash = 'jwt'; client._numinst = '386019'; client._panel = 'SDVFAST';
    await expect(() => client.setArmState('ARMED_AWAY', null)).toThrow('Code PIN');
  });

  it('setArmState lève une erreur si code PIN vide', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._authHash = 'jwt'; client._numinst = '386019'; client._panel = 'SDVFAST';
    await expect(() => client.setArmState('ARMED_AWAY', '')).toThrow('Code PIN');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — VerisureClient EventLog parsing
// ════════════════════════════════════════════════════════════════════════════
describe('VerisureClient — getDoorWindowEventsFrom parsing', () => {

  it('filtre les événements antérieurs à lastTs', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    // Mock _gql pour retourner des événements simulés
    const now = Date.now();
    const oldTs = new Date(now - 3600000).toISOString(); // 1h avant
    const newTs = new Date(now - 30000).toISOString();   // 30s avant
    client._gql = async () => ({
      xSEventLog: {
        pagedList: [
          { device: { deviceLabel: 'OLD001', area: 'Vieille porte' }, ts: oldTs, additionalInfo: 'OPEN' },
          { device: { deviceLabel: 'NEW001', area: 'Porte entrée' }, ts: newTs, additionalInfo: 'OPEN' },
          { device: { deviceLabel: 'NEW002', area: 'Fenêtre salon' }, ts: newTs, additionalInfo: 'CLOSE' },
        ],
      },
    });
    const lastTs = now - 60000; // il y a 60s
    const events = await client.getDoorWindowEventsFrom(lastTs);
    expect(events).toHaveLength(2);
    expect(events[0].deviceLabel).toBe('NEW001');
    expect(events[0].state).toBe('OPEN');
    expect(events[0].alarmContact).toBe(true);
    expect(events[1].deviceLabel).toBe('NEW002');
    expect(events[1].state).toBe('CLOSE');
    expect(events[1].alarmContact).toBe(false);
  });

  it('ignore les événements sans deviceLabel', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    const now = Date.now();
    client._gql = async () => ({
      xSEventLog: {
        pagedList: [
          { device: null, ts: new Date(now - 1000).toISOString(), additionalInfo: 'OPEN' },
          { device: { deviceLabel: 'OK001', area: 'Porte' }, ts: new Date(now - 1000).toISOString(), additionalInfo: 'CLOSE' },
        ],
      },
    });
    const events = await client.getDoorWindowEventsFrom(now - 5000);
    expect(events).toHaveLength(1);
    expect(events[0].deviceLabel).toBe('OK001');
  });

  it('ignore les événements avec additionalInfo inconnu', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    const now = Date.now();
    client._gql = async () => ({
      xSEventLog: {
        pagedList: [
          { device: { deviceLabel: 'UNK001' }, ts: new Date(now - 1000).toISOString(), additionalInfo: 'TAMPER' },
        ],
      },
    });
    const events = await client.getDoorWindowEventsFrom(now - 5000);
    expect(events).toHaveLength(0);
  });

  it('retourne un tableau vide si xSEventLog null', async () => {
    const client = new VerisureClient({ homey: makeHomey() });
    client._gql = async () => ({ xSEventLog: null });
    const events = await client.getDoorWindowEventsFrom(Date.now() - 5000);
    expect(events).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — VerisurePoller diff logic
// ════════════════════════════════════════════════════════════════════════════
describe('VerisurePoller — logique de diff', () => {

  function makePoller(settings = {}) {
    const homey = makeHomey(settings);
    homey.app = {};
    const poller = new VerisurePoller({ homey, intervalMs: 600000 });
    return { poller, homey };
  }

  it('instancie sans erreur', async () => {
    const { poller } = makePoller();
    expect(poller).toBeTruthy();
  });

  it('_lastArmState est null à l\'init', async () => {
    const { poller } = makePoller();
    expect(poller._lastArmState).toBeNull();
  });

  it('_lastEventLogTs est défini à l\'init', async () => {
    const { poller } = makePoller();
    expect(poller._lastEventLogTs).toBeGreaterThan(0);
  });

  it('_processArmState émet alarm.changed au premier appel', async () => {
    const { poller } = makePoller();
    let emitted = null;
    poller.on('alarm.changed', (data) => { emitted = data; });
    poller._processArmState({ statusType: 'DISARMED' });
    expect(emitted).toBeTruthy();
    expect(emitted.statusType).toBe('DISARMED');
    expect(emitted.homeyState).toBe('disarmed');
  });

  it('_processArmState n\'émet pas si état identique', async () => {
    const { poller } = makePoller();
    let count = 0;
    poller.on('alarm.changed', () => count++);
    poller._processArmState({ statusType: 'DISARMED' }); // 1er → émis
    poller._processArmState({ statusType: 'DISARMED' }); // même → pas émis
    expect(count).toBe(1);
  });

  it('_processArmState émet si état change', async () => {
    const { poller } = makePoller();
    const emitted = [];
    poller.on('alarm.changed', (d) => emitted.push(d));
    poller._processArmState({ statusType: 'DISARMED' });
    poller._processArmState({ statusType: 'ARMED_AWAY' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1].statusType).toBe('ARMED_AWAY');
    expect(emitted[1].homeyState).toBe('armed');
  });

  it('_processArmState met à jour _lastArmState', async () => {
    const { poller } = makePoller();
    poller._processArmState({ statusType: 'ARMED_HOME' });
    expect(poller._lastArmState).toBe('ARMED_HOME');
  });

  it("_processDoorWindows hydrate silencieusement au premier appel (pas d'evenement)", async () => {
    const { poller } = makePoller();
    let emitted = null;
    poller.on('contact.changed', (d) => { emitted = d; });
    // Premier appel = hydratation cache, AUCUNE émission (design intentionnel)
    poller._processDoorWindows([{ deviceLabel: 'AAA1', area: 'Porte', state: 'OPEN' }]);
    expect(emitted).toBeNull();
  });

  it('_processDoorWindows n emet jamais si etat identique apres hydratation', async () => {
    const { poller } = makePoller();
    let count = 0;
    poller.on('contact.changed', () => count++);
    poller._processDoorWindows([{ deviceLabel: 'BBB2', area: 'Fenêtre', state: 'CLOSE' }]); // hydratation
    poller._processDoorWindows([{ deviceLabel: 'BBB2', area: 'Fenêtre', state: 'CLOSE' }]); // même → pas émis
    poller._processDoorWindows([{ deviceLabel: 'BBB2', area: 'Fenêtre', state: 'CLOSE' }]); // même → pas émis
    expect(count).toBe(0);
  });

  it('_processDoorWindows emet uniquement au changement etat apres hydratation', async () => {
    const { poller } = makePoller();
    const events = [];
    poller.on('contact.changed', (d) => events.push(d));
    poller._processDoorWindows([{ deviceLabel: 'CCC3', area: 'Garage', state: 'CLOSE' }]); // hydratation
    poller._processDoorWindows([{ deviceLabel: 'CCC3', area: 'Garage', state: 'OPEN'  }]); // changement → émis
    poller._processDoorWindows([{ deviceLabel: 'CCC3', area: 'Garage', state: 'OPEN'  }]); // même → pas émis
    poller._processDoorWindows([{ deviceLabel: 'CCC3', area: 'Garage', state: 'CLOSE' }]); // changement → émis
    expect(events).toHaveLength(2);
    expect(events[0].state).toBe('OPEN');
    expect(events[0].alarmContact).toBe(true);
    expect(events[1].state).toBe('CLOSE');
    expect(events[1].alarmContact).toBe(false);
  });

  it('_processDoorWindowEvents gère l\'erreur sans planter', async () => {
    const { poller } = makePoller();
    poller._client = {
      getDoorWindowEventsFrom: async () => { throw new Error('API erreur simulée'); }
    };
    // Ne doit pas lever d'exception
    await poller._processDoorWindowEvents();
    expect(true).toBe(true); // si on arrive ici, c'est OK
  });

  it('getStatus retourne le bon format', async () => {
    const { poller } = makePoller();
    poller._processArmState({ statusType: 'ARMED_AWAY' });
    const s = poller.getStatus();
    expect(s.running).toBe(false);
    expect(s.lastArmState).toBe('ARMED_AWAY');
  });

  it('stop ne plante pas si non démarré', async () => {
    const { poller } = makePoller();
    poller.stop();
    expect(true).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RÉSUMÉ
// ════════════════════════════════════════════════════════════════════════════
setTimeout(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Tests : ${_passed + _failed} | ✓ ${_passed} passés | ✗ ${_failed} échoués`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(_failed > 0 ? 1 : 0);
}, 100);
