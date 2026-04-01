'use strict';

const { App }        = require('homey');
const VerisurePoller = require('./lib/VerisurePoller');
const VerisureClient = require('./lib/VerisureClient');

// Dépendances externes — utilisées dans les méthodes de diagnostic/login
let fetch, CookieJar;
try {
  fetch     = require('node-fetch');
  CookieJar = require('tough-cookie').CookieJar;
} catch(e) {
  // Si node-fetch/tough-cookie absent, les méthodes de diagnostic ne fonctionneront pas
  // mais l'app démarrera quand même
  fetch     = () => Promise.reject(new Error('node-fetch non disponible'));
  CookieJar = class { getCookieString() { return ''; } setCookie() {} static fromJSON() { return new this(); } toJSON() { return {}; } };
}

class VerisureApp extends App {

  async onInit() {
    // Buffer des 100 dernières lignes de log
    this._logBuffer = [];

    const _numinst = this.homey.settings.get('verisure_numinst') || '(non défini)';
    const _panel   = this.homey.settings.get('verisure_panel')   || '(non défini)';
    const _email   = this.homey.settings.get('verisure_email')   || '(non défini)';
    this._addLog(`[VerisureApp] Démarrage — numinst=${_numinst} panel=${_panel} email=${_email}`);

    const intervalMin = Math.max(30, parseInt(this.homey.settings.get('poll_interval_min') || '30'));
    this.poller = new VerisurePoller({
      homey:      this.homey,
      intervalMs: intervalMin * 60 * 1000,
      addLog:     (msg) => this._addLog(msg),
    });

    this.poller.on('poll.success', (data) => {
      const arm = data.armState?.statusType || '?';
      const nb  = (data.doorWindows||[]).length;
      this._addLog(`[Poller] ✅ Poll OK — ${nb} capteur(s) — alarme: ${arm}`);
    });
    this.poller.on('poll.error', (err) => {
      this._addLog(`[Poller] ❌ Erreur poll: ${err.message}`);
    });
    this.poller.on('alarm.changed', (data) => {
      this._addLog(`[Poller] 🔔 Alarme changée: ${data.statusType} → ${data.homeyState}`);
    });
    this.poller.on('session.expired', () => {
      this._addLog('[Poller] ❌ Session expirée — reconnexion requise dans les réglages');
      // Notifier l'utilisateur via Homey
      this.homey.notifications.createNotification({
        excerpt: '⚠️ Verisure : session expirée. Reconnectez-vous dans les réglages de l\'application.',
      }).catch(() => {});
    });

    this._registerFlowActions();
    await this.poller.start();
    this.homey.settings.on('set', key => this._onSettingChanged(key));
    this._addLog('[VerisureApp] Prêt');
  }


  async onUninit() {
    if (this.poller) this.poller.stop();
  }

  // ---------------------------------------------------------------------------
  // Méthodes appelées depuis api.js
  // ---------------------------------------------------------------------------

  // Étape 1 → retourne la liste des téléphones
  // On conserve le client en mémoire (this._mfaClient) pour garder les cookies
  async sessionLogin(email, password) {
    this._addLog('[VerisureApp] sessionLogin');
    this._mfaClient = new VerisureClient({ homey: this.homey, email, password });
    const phones = await this._mfaClient.initiateLogin(email, password);
    return phones;
  }

  // Étape 2 → envoie le SMS (même client = mêmes cookies)
  async sessionRequestOtp(phoneIndex) {
    this._addLog('[VerisureApp] sessionRequestOtp');
    if (!this._mfaClient) {
      // Fallback : recréer depuis les settings si le client a été perdu
      this._mfaClient = new VerisureClient({ homey: this.homey });
      this._mfaClient._restoreSession();
    }
    await this._mfaClient.requestOtp(phoneIndex);
  }

  // Étape 3 → valide le code (même client = mêmes cookies)
  async sessionMfa(code) {
    this._addLog('[VerisureApp] sessionMfa');
    if (!this._mfaClient) {
      this._mfaClient = new VerisureClient({ homey: this.homey });
      this._mfaClient._restoreSession();
    }

    // confirmMfa appelle _initGiid en interne → numinst + capabToken peuplés
    await this._mfaClient.confirmMfa(code);
    this._addLog(`[VerisureApp] MFA OK — numinst=${this._mfaClient._numinst} capab=${this._mfaClient._capabToken ? 'OK' : 'absent'}`);

    // Garantir que les settings clés sont écrits AVANT de retourner ok:true
    // Cela évite la race condition où index.html lit des settings vides
    const c = this._mfaClient;
    if (c._authHash)   await this.homey.settings.set('verisure_auth_hash', c._authHash);
    if (c._email)      await this.homey.settings.set('verisure_email',     c._email);
    if (c._numinst)    await this.homey.settings.set('verisure_numinst',   c._numinst);
    if (c._panel)      await this.homey.settings.set('verisure_panel',     c._panel);
    if (c._owner)      await this.homey.settings.set('verisure_owner',     c._owner);
    if (c._address)    await this.homey.settings.set('verisure_address',   c._address);
    this._addLog('[VerisureApp] Settings clés persistés avant retour ok:true');

    // Injecter le client directement dans le poller AVANT le restart
    if (this.poller) {
      this.poller.stop();
      this.poller._client = this._mfaClient;
      this._mfaClient = null;
      this._addLog('[VerisureApp] Client MFA injecté dans le poller');
      await this.poller.start();
    } else {
      this._mfaClient = null;
    }
  }

  async sessionClear() {
    this._addLog('[VerisureApp] sessionClear');
    const client = new VerisureClient({ homey: this.homey });
    await client.clearSession();
    this.poller.stop();
  }

  _addLog(msg) {
    if (!this._logBuffer) this._logBuffer = [];
    const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
    this._logBuffer.push(line);
    if (this._logBuffer.length > 500) this._logBuffer.shift();
    this.log(msg);
  }

  getLogs() {
    return (this._logBuffer || []).join('\n') || 'Aucun log disponible.';
  }

  // Vérification OTP depuis le diagnostic — appelé par /verify-otp
  // Restaure le cookie jar de sendOtpForTest et rappelle mkValidateDevice(password)
  async verifyOtpForTest(email, otp) {
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';

    const sessionId  = this.homey.settings.get('verisure_pending_session_id');
    const password   = this.homey.settings.get('verisure_pending_password') || '';
    const numinst    = this.homey.settings.get('verisure_numinst') || '';
    const panel      = this.homey.settings.get('verisure_panel')   || '';
    const loginTs    = parseInt(this.homey.settings.get('verisure_pending_login_ts') || '0') || Date.now();
    const jarRaw     = this.homey.settings.get('verisure_pending_jar');
    if (!jarRaw) throw new Error('Session expirée — relancez le test login');

    // Restaurer le jar avec les cookies posés par mkSendOTP
    const jar = CookieJar.fromJSON(JSON.parse(jarRaw));
    const fetchJ = async (url, opts) => {
      const cookieStr = await jar.getCookieString(url);
      const h = { ...(opts.headers || {}) };
      if (cookieStr) h['Cookie'] = cookieStr;
      const res = await fetch(url, { ...opts, headers: h });
      const sc = res.headers.raw()['set-cookie'] || [];
      await Promise.all(sc.map(c => jar.setCookie(c, url).catch(() => {})));
      return res;
    };

    // Le dernier mkValidateDevice utilise hash:null + header security avec le code OTP
    const otpForValidate = this.homey.settings.get('verisure_otp_for_validate') || null;
    this._addLog('[VerisureApp] otpForValidate pour security header: ' + (otpForValidate ? otpForValidate.slice(0,30)+'...' : 'null'));
    const authNullHash = JSON.stringify({
      loginTimestamp: loginTs, user: email, id: sessionId,
      country: 'FR', lang: 'fr', callby: 'OWP_10', hash: null,
    });
    // Header security avec le code OTP, type OTP, et otpHash
    const securityHeader = JSON.stringify({
      token: otp,
      type: 'OTP',
      otpHash: otpForValidate,
    });
    this._addLog('[VerisureApp] security header: ' + securityHeader.slice(0, 80));

    const headers = {
      'Content-Type': 'application/json', 'Accept': '*/*',
      'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
      'auth': authNullHash, 'numinst': numinst, 'panel': panel,
      'security': securityHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    this._addLog('[VerisureApp] verifyOtpForTest — mkValidateDevice avec header security');

    const r = await fetchJ(API_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        operationName: 'mkValidateDevice',
        query: `mutation mkValidateDevice($password:String) {
          xSValidateDevice(password:$password) {
            res msg hash refreshToken legals __typename
          }
        }`,
        variables: { password },
      }),
    });
    const j = await r.json();
    this._addLog('[VerisureApp] mkValidateDevice (verify) → ' + JSON.stringify(j).slice(0, 300));

    const err0 = j.errors?.[0];
    if (err0?.name === 'SecurityError') {
      return { success: false, reason: 'Code OTP non reconnu — cookies invalides ou code expiré', raw: { errors: j.errors } };
    }

    const result = j?.data?.xSValidateDevice;
    if (result?.res === 'OK' && result?.hash) {
      // CRITIQUE : lire le sessionId et loginTs AVANT de les effacer
      const finalSessionId = this.homey.settings.get('verisure_pending_session_id');
      const finalLoginTs   = parseInt(this.homey.settings.get('verisure_pending_login_ts') || '0') || Date.now();

      await this.homey.settings.set('verisure_auth_hash',    result.hash);
      await this.homey.settings.set('verisure_login_ts',     String(finalLoginTs));
      await this.homey.settings.set('verisure_email',        email);
      await this.homey.settings.set('verisure_cookies',      'active');
      // Sauvegarder le sessionId définitif (sera utilisé pour tous les polls)
      if (finalSessionId) await this.homey.settings.set('verisure_session_id', finalSessionId);
      if (result.refreshToken) {
        await this.homey.settings.set('verisure_refresh_token', result.refreshToken);
      }
      await this.homey.settings.unset('verisure_pending_otp_hash');
      await this.homey.settings.unset('verisure_pending_session_id');
      await this.homey.settings.unset('verisure_pending_email');
      await this.homey.settings.unset('verisure_pending_password');
      await this.homey.settings.unset('verisure_pending_jar');
      this._addLog('[VerisureApp] ✅ Connexion réussie ! JWT=' + result.hash.slice(0,20) + ' | sid=' + (finalSessionId||'?').slice(0,35));

      // Persister le jar de cookies (Incapsula) AVANT _initGiid
      try { await this.homey.settings.set('verisure_cookie_jar', JSON.stringify(jar.toJSON())); } catch(e2) {}

      // Résoudre numinst via xSInstallations puis capabilities via xSSrv
      try {
        const authObj = JSON.stringify({
          loginTimestamp: finalLoginTs, user: email, id: finalSessionId,
          country: 'FR', lang: 'fr', callby: 'OWP_10', hash: result.hash,
        });
        const BASE_H = {
          'Content-Type': 'application/json', 'Accept': '*/*',
          'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
          'auth': authObj,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };

        // Étape 1 : xSInstallations — pas besoin de numinst dans les headers
        this._addLog('[VerisureApp] Récupération installations...');
        const instRes = await fetchJ(API_URL, {
          method: 'POST', headers: BASE_H,
          body: JSON.stringify({
            operationName: 'mkInstallationList',
            query: `query mkInstallationList {
              xSInstallations {
                installations { numinst alias panel name surname address city postcode __typename }
                __typename
              }
            }`,
          }),
        });
        const instJson = await instRes.json();
        this._addLog('[VerisureApp] xSInstallations → ' + JSON.stringify(instJson).slice(0, 200));
        const instList = instJson?.data?.xSInstallations?.installations ?? [];
        if (!instList.length) throw new Error('Aucune installation trouvée via xSInstallations');

        const inst0     = instList[0];
        const numinst   = String(inst0.numinst);
        const panel     = inst0.panel || '';
        const owner     = [inst0.name, inst0.surname].filter(Boolean).join(' ');
        const address   = [inst0.address, inst0.city, inst0.postcode].filter(Boolean).join(', ');
        await this.homey.settings.set('verisure_numinst', numinst);
        await this.homey.settings.set('verisure_giid',    numinst);
        await this.homey.settings.set('verisure_panel',   panel);
        if (owner)       await this.homey.settings.set('verisure_owner',   owner);
        if (address)     await this.homey.settings.set('verisure_address', address);
        if (inst0.alias) await this.homey.settings.set('verisure_alias',   inst0.alias);
        this._addLog('[VerisureApp] ✅ Installation — numinst=' + numinst + ' panel=' + panel);

        // Étape 2 : xSSrv avec le numinst obtenu → capabilities token
        this._addLog('[VerisureApp] Récupération capabilities (xSSrv)...');
        const srvRes = await fetchJ(API_URL, {
          method: 'POST',
          headers: { ...BASE_H, 'numinst': numinst, 'panel': panel, 'x-installationNumber': numinst },
          body: JSON.stringify({
            operationName: 'Srv',
            query: `query Srv($numinst: String!) {
              xSSrv(numinst: $numinst) {
                res
                installation { capabilities __typename }
                __typename
              }
            }`,
            variables: { numinst },
          }),
        });
        const srvJson = await srvRes.json();
        this._addLog('[VerisureApp] xSSrv → ' + JSON.stringify(srvJson).slice(0, 200));
        const cap = srvJson?.data?.xSSrv?.installation?.capabilities;
        if (cap) {
          await this.homey.settings.set('verisure_capab_token', cap);
          this._addLog('[VerisureApp] ✅ capabilities token OK');
        } else {
          this._addLog('[VerisureApp] ⚠️ capabilities absent dans xSSrv (non bloquant)');
        }

        // Démarrer le poller et injecter les valeurs directement dans le client
        if (this.poller) {
          await this.poller.restart();
          // Injecter numinst/panel/capabToken dans le client actif du poller
          // (évite une course condition avec la lecture des settings)
          if (this.poller._client) {
            this.poller._client._numinst    = numinst;
            this.poller._client._panel      = panel;
            this.poller._client._authHash   = result.hash;
            this.poller._client._loginTs    = finalLoginTs;
            this.poller._client._sessionId  = finalSessionId;
            this.poller._client._email      = email;
            if (cap) this.poller._client._capabToken = cap;
            this._addLog('[VerisureApp] ✅ Poller client mis à jour — numinst=' + numinst);
          }
        }
      } catch(e) {
        this._addLog('[VerisureApp] Avertissement post-login : ' + e.message);
      }

      return { success: true, email, hash: result.hash.slice(0,20)+'...' };
    }

    return { success: false, reason: 'Réponse inattendue', raw: j };
  }


  // Envoi OTP depuis le diagnostic — appelé par /send-otp
  async sendOtpForTest(email, recordId) {
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';

    const otpHash   = this.homey.settings.get('verisure_pending_otp_hash');
    const sessionId = this.homey.settings.get('verisure_pending_session_id');
    const numinst   = this.homey.settings.get('verisure_numinst') || '';
    const panel     = this.homey.settings.get('verisure_panel')   || '';
    const loginTs   = parseInt(this.homey.settings.get('verisure_pending_login_ts') || '0') || Date.now();
    if (!otpHash) throw new Error('Session expirée — relancez le test login');

    // Cookie jar partagé — les cookies posés par mkSendOTP seront réutilisés pour mkValidateDevice
    const jar = new CookieJar();
    const fetchJ = async (url, opts) => {
      const cookieStr = await jar.getCookieString(url);
      const h = { ...(opts.headers || {}) };
      if (cookieStr) h['Cookie'] = cookieStr;
      const res = await fetch(url, { ...opts, headers: h });
      const sc = res.headers.raw()['set-cookie'] || [];
      await Promise.all(sc.map(c => jar.setCookie(c, url).catch(() => {})));
      return res;
    };

    // mkSendOTP utilise hash:otpHash dans auth (comme le site)
    const authWithHash = JSON.stringify({
      loginTimestamp: loginTs, user: email, id: sessionId,
      country: 'FR', lang: 'fr', callby: 'OWP_10', hash: otpHash,
    });
    const headers = {
      'Content-Type': 'application/json', 'Accept': '*/*',
      'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
      'auth': authWithHash, 'numinst': numinst, 'panel': panel,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    // mkSendOTP — récupérer aussi hash (JWT retourné après envoi SMS)
    const r = await fetchJ(API_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        operationName: 'mkSendOTP',
        query: `mutation mkSendOTP($recordId:Int!,$otpHash:String!) {
          xSSendOtp(recordId:$recordId,otpHash:$otpHash) { res msg __typename }
        }`,
        variables: { recordId: parseInt(recordId, 10), otpHash },
      }),
    });
    const j = await r.json();
    this._addLog('[VerisureApp] mkSendOTP → ' + JSON.stringify(j).slice(0, 300));

    const result = j?.data?.xSSendOtp;
    if (result?.res !== 'OK') {
      return { res: result?.res, msg: result?.msg || 'Échec envoi SMS', raw: j };
    }

    // NE PAS écraser verisure_pending_otp_hash — l'otpHash du SecurityError est déjà sauvegardé
    // C'est lui qui sera utilisé dans mkValidateDevice final (hash: otpHash_A)

    // Sauvegarder le jar
    const jarJson = JSON.stringify(jar.toJSON());
    await this.homey.settings.set('verisure_pending_jar', jarJson);

    return { res: 'OK', msg: 'SMS envoyé — saisissez le code reçu', hashReceived: !!result?.hash };
  }


  // Test capabilities — appelé par /test-capabilities
  async testCapabilities() {
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
    const hash    = this.homey.settings.get('verisure_auth_hash');
    const email   = this.homey.settings.get('verisure_email') || '';
    const numinst = this.homey.settings.get('verisure_numinst') || '';
    const panel   = this.homey.settings.get('verisure_panel') || '';
    if (!hash) return { error: 'Pas de JWT' };
    const authObj = JSON.stringify({
      loginTimestamp: Date.now(), user: email,
      id: 'OWP_______________' + email + '_______________test',
      country: 'FR', lang: 'fr', callby: 'OWP_10', hash,
    });
    const headers = {
      'Content-Type': 'application/json', 'Accept': '*/*',
      'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
      'auth': authObj, 'numinst': numinst, 'panel': panel,
      'x-installationNumber': numinst,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    const results = {};
    const queries = [
      ['xSCapabilities', 'query xSCapabilities($numinst:String!){xSCapabilities(numinst:$numinst){res token __typename}}'],
      ['xSGetCapabilities', 'query xSGetCapabilities($numinst:String!){xSGetCapabilities(numinst:$numinst){res token __typename}}'],
      ['xSUserCapabilities', 'query xSUserCapabilities($numinst:String!){xSUserCapabilities(numinst:$numinst){res token __typename}}'],
      ['Srv', 'query Srv($numinst:String!){xSSrv(numinst:$numinst){res msg installation{capabilities __typename}__typename}}'],
    ];
    for (const [name, query] of queries) {
      try {
        const r = await fetch(API_URL, {
          method: 'POST', headers,
          body: JSON.stringify({ operationName: name, query, variables: { numinst } }),
        });
        const j = await r.json();
        results[name] = j;
        this._addLog('[testCapabilities] ' + name + ': ' + JSON.stringify(j).slice(0, 150));
      } catch(e) {
        results[name] = { error: e.message };
      }
    }
    return { ok: true, results };
  }

  // Test status — appelé par /test-status (diagnostic xSStatus complet)
  async testStatus() {
    try {
      const VerisureClient = require('./lib/VerisureClient');
      const client = VerisureClient.fromSettings({ homey: this.homey });
      // Forcer récupération du capabilities token si absent
      if (!client._capabToken) {
        this._addLog('[testStatus] pas de capabToken — fetch xSSrv');
        await client._fetchCapabilities();
      }
      this._addLog('[testStatus] capabToken: ' + (client._capabToken ? 'OK (' + client._capabToken.slice(0,20) + '...)' : 'absent'));
      const numinst = client._numinst || this.homey.settings.get('verisure_numinst') || '';
        const headers = client._fullHeaders();
      const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
      const r = await fetch(API_URL, {
        method: 'POST', headers,
        body: JSON.stringify({
          operationName: 'Status',
          query: `query Status($numinst: String!) {
            xSStatus(numinst: $numinst) {
              status timestampUpdate wifiConnected powerStatus keepAliveDay
              exceptions { status deviceType alias __typename }
              __typename
            }
          }`,
          variables: { numinst },
        }),
      });
      const j = await r.json();
      return { ok: true, capabTokenPresent: !!client._capabToken, raw: j };
    } catch(e) {
      return { error: e.message };
    }
  }

  // Test alarm — appelé par /test-alarm
  async testAlarm() {
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
    const hash    = this.homey.settings.get('verisure_auth_hash');
    const email   = this.homey.settings.get('verisure_email') || '';
    const numinst = this.homey.settings.get('verisure_numinst') || '';
    const panel   = this.homey.settings.get('verisure_panel') || '';

    if (!hash) return { error: 'Pas de JWT' };

    const _loginTs = parseInt(this.homey.settings.get('verisure_login_ts') || '0') || Date.now();
    const _d = new Date(_loginTs);
    const _sid = `OWP_______________${email}_______________${_d.getFullYear()}${_d.getMonth()+1}${String(_d.getDate()).padStart(2,'0')}${String(_d.getHours()).padStart(2,'0')}${String(_d.getMinutes()).padStart(2,'0')}${String(_d.getSeconds()).padStart(2,'0')}`;
    const authObj = JSON.stringify({
      loginTimestamp: _loginTs, user: email, id: _sid,
      country: 'FR', lang: 'fr', callby: 'OWP_10', hash,
    });
    const headers = {
      'Content-Type': 'application/json', 'Accept': '*/*',
      'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
      'auth': authObj, 'numinst': numinst, 'panel': panel,
      'x-installationNumber': numinst,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    try {
      // Étape 1 : CheckAlarm
      const r1 = await fetch(API_URL, {
        method: 'POST', headers,
        body: JSON.stringify({
          operationName: 'CheckAlarm',
          query: `query CheckAlarm($numinst: String!, $panel: String!) {
            xSCheckAlarm(numinst: $numinst, panel: $panel) { res msg referenceId __typename }
          }`,
          variables: { numinst, panel },
        }),
      });
      const j1 = await r1.json();
      this._addLog('[testAlarm] CheckAlarm: ' + JSON.stringify(j1).slice(0, 200));

      const referenceId = j1?.data?.xSCheckAlarm?.referenceId;
      if (!referenceId) return { step: 'CheckAlarm', result: j1 };

      // Étape 2 : polling CheckAlarmStatus
      const logs = [`referenceId: ${referenceId}`];
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const r2 = await fetch(API_URL, {
          method: 'POST', headers,
          body: JSON.stringify({
            operationName: 'CheckAlarmStatus',
            query: `query CheckAlarmStatus($numinst: String!, $idService: String!, $panel: String!, $referenceId: String!) {
              xSCheckAlarmStatus(numinst: $numinst, idService: $idService, panel: $panel, referenceId: $referenceId) {
                res msg status numinst protomResponse protomResponseDate forcedArmed __typename
              }
            }`,
            variables: { numinst, idService: '11', panel, referenceId },
          }),
        });
        const j2 = await r2.json();
        const s = j2?.data?.xSCheckAlarmStatus;
        logs.push(`tentative ${i+1}: res=${s?.res} protomResponse=${s?.protomResponse} status=${s?.status}`);
        if (s?.res === 'OK' && (s?.protomResponse || s?.status)) {
          return { ok: true, checkAlarm: j1, checkAlarmStatus: j2, logs };
        }
        if (s?.res === 'ERROR') return { ok: false, error: 'ERROR', checkAlarmStatus: j2, logs };
      }
      return { ok: false, reason: 'timeout', logs };
    } catch(e) {
      return { error: e.message };
    }
  }

  // Init giid — appelé par /init-giid
  async initGiid() {
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
    const hash    = this.homey.settings.get('verisure_auth_hash');
    const email   = this.homey.settings.get('verisure_email') || '';
    const numinst = this.homey.settings.get('verisure_numinst') || '';
    const panel   = this.homey.settings.get('verisure_panel') || '';

    if (!hash) return { error: 'Pas de JWT — reconnectez-vous' };

    const authObj = JSON.stringify({
      loginTimestamp: Date.now(), user: email,
      id: `OWP_______________${email}_______________${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}`,
      country: 'FR', lang: 'fr', callby: 'OWP_10', hash,
    });

    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Accept': '*/*',
          'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
          'auth': authObj, 'numinst': numinst, 'panel': panel,
          'x-installationNumber': numinst,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          operationName: 'mkInstallationList',
          query: `query mkInstallationList {
            xSInstallations {
              installations { numinst alias panel name surname address city postcode __typename }
              __typename
            }
          }`,
        }),
      });
      const j = await r.json();
      this._addLog('[VerisureApp] initGiid raw: ' + JSON.stringify(j).slice(0, 300));

      this._addLog('[VerisureApp] xSInstallations raw: ' + JSON.stringify(j).slice(0, 500));
      const instList = j?.data?.xSInstallations?.installations ?? [];
      if (instList.length) {
        const inst      = instList[0];
        const installId = inst.numinst || numinst;
        const alias     = inst.alias   || inst.name || '';
        const panelType = inst.panel   || '';
        const address   = [inst.address, inst.city, inst.postcode].filter(Boolean).join(', ');
        const owner     = [inst.name, inst.surname].filter(Boolean).join(' ');
        await this.homey.settings.set('verisure_numinst', String(installId));
        await this.homey.settings.set('verisure_panel',   panelType);
        await this.homey.settings.set('verisure_alias',   alias);
        await this.homey.settings.set('verisure_address', address);
        await this.homey.settings.set('verisure_owner',   owner);
        // Utiliser numinst comme giid si pas de giid disponible
        await this.homey.settings.set('verisure_giid',    String(installId));
        // Enrichir avec xSStatus pour wifiConnected, powerStatus, keepAliveDay
        let wifiConnected, powerStatus, keepAliveDay;
        try {
          const client = this.poller?._client;
          if (client) {
            const armInfo = await client.getArmState().catch(() => null);
            if (armInfo) {
              wifiConnected = armInfo.wifiConnected;
              powerStatus   = armInfo.powerStatus;
              keepAliveDay  = armInfo.keepAliveDay;
            }
          }
        } catch(_) {}

        // Persister wifi/power/keepalive pour lecture par index.html
        if (wifiConnected !== undefined) await this.homey.settings.set('verisure_wifi_connected', wifiConnected).catch(()=>{});
        if (powerStatus)   await this.homey.settings.set('verisure_power_status',   powerStatus).catch(()=>{});
        if (keepAliveDay)  await this.homey.settings.set('verisure_keep_alive_day', String(keepAliveDay)).catch(()=>{});

        return { ok: true, giid: installId, alias, owner, address, installId, panelType,
                 wifiConnected, powerStatus, keepAliveDay, raw: j };
      }
      return { ok: false, reason: 'xSInstallations vide', raw: j };
    } catch(e) {
      return { error: e.message };
    }
  }

  // Test JWT direct — appelé par /test-jwt
  async testJwt(email, jwtHash) {
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
    const sid     = `OWP_______________${email}_______________${Date.now()}`;
    const authObj = JSON.stringify({
      loginTimestamp: Date.now(),
      user: email, id: sid,
      country: 'FR', lang: 'fr', callby: 'OWP_10',
      hash: jwtHash,
    });
    const headers = {
      'Content-Type':     'application/json',
      'Accept':           '*/*',
      'app-origin':       'web',
      'app-version':      'n/a',
      'app-version-code': '2.2.2',
      'auth':             authObj,
    };
    const results = {};
    // Headers complets — copie exacte du trafic capturé depuis le site
    const now = new Date();
    const dtStr = `${now.getFullYear()}${now.getMonth()+1}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    const sidFmt = `OWP_______________${email}_______________${dtStr}`;
    const authObjFmt = JSON.stringify({
      loginTimestamp: Date.now(),
      user: email, id: sidFmt,
      country: 'FR', lang: 'fr', callby: 'OWP_10',
      hash: jwtHash,
    });

    const HEADERS_JWT = {
      'Content-Type':     'application/json',
      'Accept':           '*/*',
      'app-origin':       'web',
      'app-version':      'n/a',
      'app-version-code': '2.2.2',
      'auth':             authObjFmt,
      'numinst': this.homey.settings.get('verisure_numinst') || '',
      'panel':   this.homey.settings.get('verisure_panel')   || '',
      'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'origin':           'https://customers.securitasdirect.fr',
      'referer':          'https://customers.securitasdirect.fr/owa-static/home',
    };

    // Détecter si c'est un JWT (commence par eyJ) ou un mot de passe
    const isJwt = jwtHash.startsWith('eyJ');
    results._inputType = isJwt ? 'JWT' : 'password';
    if (isJwt) {
      try {
        const parts = jwtHash.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const nowMs = Date.now();
        results._jwtInfo = {
          issuedAt:  new Date(payload.iat * 1000).toISOString(),
          expiresAt: new Date(payload.exp * 1000).toISOString(),
          expired:   nowMs > payload.exp * 1000,
          sessionToken: payload.sessionToken,
        };
        if (nowMs > payload.exp * 1000) {
          return { error: 'JWT EXPIRÉ — récupérez un nouveau JWT depuis DevTools Network', results };
        }
      } catch(e) { results._jwtInfo = { parseError: e.message }; }
    }

    const gql = async (name, query, variables, extraHeaders) => {
      try {
        const h = extraHeaders ? { ...HEADERS_JWT, ...extraHeaders } : HEADERS_JWT;
        const r = await fetch(API_URL, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ query, variables }),
        });
        results[name] = await r.json();
      } catch(e) { results[name] = { error: e.message }; }
    };

    const phoneQuery = `query P($id:String!,$user:String!,$lang:String!,$country:String!) { xSLoginPhones(id:$id,user:$user,lang:$lang,country:$country) { res phones { index phone } } }`;
    const phoneVars  = { id: sidFmt, user: email, lang: 'fr', country: 'FR' };
    const otpQuery   = `mutation R($id:String!,$user:String!,$lang:String!,$country:String!,$phoneIndex:Int!) { xSRequestOtp(id:$id,user:$user,lang:$lang,country:$country,phoneIndex:$phoneIndex) { res } }`;
    const otpVars    = { id: sidFmt, user: email, lang: 'fr', country: 'FR', phoneIndex: 0 };

    // ── FLOW DÉCOUVERT : xSValidateDevice → xSLoginPhones ──────────────────
    // xSValidateDevice(password) → hash + refreshToken (capabilities)
    // puis xSLoginPhones avec ce hash

    const validateHeaders = {
      'Content-Type': 'application/json', 'Accept': '*/*',
      'app-origin': 'web', 'app-version': 'n/a', 'app-version-code': '2.2.2',
      'User-Agent': HEADERS_JWT['User-Agent'],
    };

    // Étape 1 : xSValidateDevice(password) — auth avec hash:null
    const authNullHash = JSON.stringify({
      loginTimestamp: Date.now(),
      user: email, id: sidFmt,
      country: 'FR', lang: 'fr', callby: 'OWP_10',
      hash: null,
    });
    const validateHeadersWithAuth = { ...validateHeaders, 'auth': authNullHash };

    let otpHash = null;
    try {
      const r = await fetch(API_URL, {
        method: 'POST', headers: validateHeadersWithAuth,
        body: JSON.stringify({
          operationName: 'mkValidateDevice',
          query: `mutation mkValidateDevice($password:String) {
            xSValidateDevice(password:$password) {
              res msg hash refreshToken __typename
            }
          }`,
          variables: { password: jwtHash },
        }),
      });
      const j = await r.json();
      results['step1_validateDevice'] = {
        errors: j.errors,
        data:   j.data,
      };
      // Extraire otpHash depuis SecurityError (réponse normale pour comptes MFA)
      const err0 = j.errors?.[0];
      if (err0?.name === 'SecurityError' && err0?.data?.['auth-otp-hash']) {
        otpHash = err0.data['auth-otp-hash'];
        results['auth_phones'] = err0.data['auth-phones'];
        results['step1_status'] = 'OK — SecurityError MFA avec otpHash et téléphones';
      } else if (j?.data?.xSValidateDevice?.hash) {
        otpHash = j.data.xSValidateDevice.hash;
        results['step1_status'] = 'OK — hash direct';
      }
      // Sauvegarder numinst/panel, password et loginTimestamp pour les étapes suivantes
      // verisure_numinst sera défini par _initGiid via xSSrv
      // verisure_panel sera défini par _initGiid via xSSrv
      await this.homey.settings.set('verisure_pending_password',   jwtHash);
      await this.homey.settings.set('verisure_pending_login_ts',   String(Date.now()));
    } catch(e) { results['step1_validateDevice'] = { error: e.message }; }

    if (!otpHash) {
      results['note'] = 'xSValidateDevice échoué — vérifiez le mot de passe.';
      return { sidUsed: sidFmt, results };
    }

    // Les téléphones viennent directement du SecurityError — pas besoin de xSLoginPhones
    // Étape 2 : xSSendOtp avec le premier téléphone disponible
    const authPhones = results['auth_phones'] || [];
    const stepAuthObj = JSON.stringify({
      loginTimestamp: Date.now(), user: email, id: sidFmt,
      country: 'FR', lang: 'fr', callby: 'OWP_10', hash: otpHash,
    });
    const headersWithAuth = { ...HEADERS_JWT, auth: stepAuthObj };

    // Stocker otpHash dans les settings pour l'étape suivante (envoi SMS)
    try {
        await this.homey.settings.set('verisure_pending_otp_hash',   otpHash);
      await this.homey.settings.set('verisure_otp_for_validate',   otpHash);
      await this.homey.settings.set('verisure_pending_session_id', sidFmt);
      await this.homey.settings.set('verisure_pending_email',      email);
    } catch(e) {}

    // Retourner les téléphones pour que l'UI puisse les afficher
    // L'utilisateur choisira ensuite via testJwtSendOtp(recordId)
    return {
      sidUsed:   sidFmt,
      otpHash:   otpHash ? otpHash.slice(0, 30) + '...' : null,
      status:    'PHONES_READY',
      phones:    authPhones,
      next_step: 'Appelez testJwtSendOtp avec le recordId choisi',
      results,
    };
  }

  // Diagnostic : retourne la réponse brute de xSLoginToken + ProbePhones

  
  async sessionDebug(email, password, bearerToken) {
    // ── DIAGNOSTIC v2 : retourner immédiatement pour confirmer la réception ──
    this._addLog('[VerisureApp] sessionDebug v2 JWT=' + (bearerToken ? bearerToken.slice(0,20) : 'VIDE'));
    if (bearerToken) {
      return {
        version: 'app.js-v2',
        jwtReceived: true,
        jwtPreview: bearerToken.slice(0, 30) + '...',
        email: email,
        message: 'Nouveau app.js bien chargé — JWT reçu, test en cours...',
      };
    }
    const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
    const jar = new CookieJar();

    // Fetch avec cookie jar manuel
    async function fetchJ(url, opts) {
      const cookieStr = await jar.getCookieString(url);
      const headers = { ...(opts.headers || {}) };
      if (cookieStr) headers['Cookie'] = cookieStr;
      const res = await fetch(url, { ...opts, headers });
      const sc = res.headers.raw()['set-cookie'] || [];
      await Promise.all(sc.map(c => jar.setCookie(c, url).catch(() => {})));
      return res;
    }
    const HEADERS = {
      'Content-Type':      'application/json',
      'Accept':            '*/*',
      'app-origin':        'web',
      'app-version':       'n/a',
      'app-version-code':  '2.2.2',
      'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    };
    const _now = new Date();
    const _dt  = `${_now.getFullYear()}${_now.getMonth()+1}${String(_now.getDate()).padStart(2,'0')}${String(_now.getHours()).padStart(2,'0')}${String(_now.getMinutes()).padStart(2,'0')}${String(_now.getSeconds()).padStart(2,'0')}`;
    const sessionId = `OWP_______________${email}_______________${_dt}`;

    // ── Mode JWT : si hash fourni, tester directement avec header auth ────
    if (bearerToken) {
      const authObj = JSON.stringify({
        loginTimestamp: Date.now(),
        user: email, id: sessionId,
        country: 'FR', lang: 'fr', callby: 'OWP_10',
        hash: bearerToken,
      });
      const authHeaders = { ...HEADERS, 'auth': authObj };
      const probeAuth = {};
      const tests = [
        { name: 'account',
          q: `query { account { installations { giid alias __typename } __typename } }`,
          vars: {} },
        { name: 'xSLoginPhones',
          q: `query P($id:String!,$user:String!,$lang:String!,$country:String!) { xSLoginPhones(id:$id,user:$user,lang:$lang,country:$country) { res phones { index phone } } }`,
          vars: { id: sessionId, user: email, lang: 'fr', country: 'FR' } },
      ];
      for (const { name, q, vars } of tests) {
        try {
          const r = await fetchJ(API_URL, {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ query: q, variables: vars }),
          });
          probeAuth[name] = await r.json();
        } catch(e) { probeAuth[name] = { error: e.message }; }
      }
      return { mode: 'auth-header-test', authHeader: authObj, probeAuth };
    }

    // Étape 0 : GET sur la page d'accueil pour obtenir les cookies Incapsula
    let incapCookies = '';
    try {
      const r0 = await fetchJ('https://customers.securitasdirect.fr/owa-static/login', {
          method: 'GET',
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        },
        redirect: 'follow',
      });
      const incapRaw = r0.headers.raw()['set-cookie'] || [];
      incapCookies = incapRaw.map(c => c.split(';')[0]).join('; ');
      HEADERS['Cookie'] = incapCookies;
    } catch(e) {}

    // Étape 1 : xSLoginToken
    const r1 = await fetchJ(API_URL, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        operationName: 'mkLoginToken',
        query: `mutation mkLoginToken($user:String!,$password:String!,$id:String!,$country:String!,$lang:String!,$callby:String!) {
          xSLoginToken(user:$user,password:$password,id:$id,country:$country,lang:$lang,callby:$callby) {
            res msg hash lang legals mainUser changePassword __typename
          }
        }`,
        variables: { user: email, password, id: sessionId, country: 'FR', lang: 'fr', callby: 'OWP_10' },
      }),
    });
    const t1 = await r1.text();
    const j1 = JSON.parse(t1);
    const hash = j1?.data?.xSLoginToken?.hash;

    // Capturer TOUS les headers de réponse pour diagnostic
    const allResponseHeaders = {};
    r1.headers.forEach((value, key) => { allResponseHeaders[key] = value; });

    const rawCookies = r1.headers.raw()['set-cookie'] || [];
    const cookies = rawCookies.map(c => c.split(';')[0]).join('; ');
    const HEADERS_WITH_COOKIES = cookies ? { ...HEADERS, 'Cookie': cookies } : HEADERS;

    // hash null = normal pour Verisure France (auth-api.mfa_needed)
    // On continue le diagnostic pour trouver xSLoginPhones

    // Étape 2 : tester xSLoginPhones SANS hash (c'est le bon flow France)
    const probeResults = {};
    const baseVars = { id: sessionId, country: 'FR', lang: 'fr', callby: 'OWP_10', user: email };

    // Test A : xSLoginPhones sans hash, champ phones
    const phoneCandidates = [
      {
        field: 'xSLoginPhones',
        vars: baseVars,
        query: `query P1($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!) {
          xSLoginPhones(id:$id,country:$country,lang:$lang,callby:$callby,user:$user) {
            res msg phones { index phone __typename } __typename
          }
        }`,
      },
      {
        field: 'xSLoginPhones_otpPhones',
        vars: baseVars,
        query: `query P2($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!) {
          xSLoginPhones(id:$id,country:$country,lang:$lang,callby:$callby,user:$user) {
            res msg otpPhones { index phone __typename } __typename
          }
        }`,
      },
      {
        field: 'xSOtpPhones',
        vars: baseVars,
        query: `query P3($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!) {
          xSOtpPhones(id:$id,country:$country,lang:$lang,callby:$callby,user:$user) {
            res msg phones { index phone __typename } __typename
          }
        }`,
      },
      {
        field: 'xSLoginPhones_noArgs',
        vars: baseVars,
        query: `query P4($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!) {
          xSLoginPhones(id:$id,country:$country,lang:$lang,callby:$callby,user:$user) {
            res msg __typename
          }
        }`,
      },
    ];

    // Combiner TOUS les cookies
    const allCookies = [
      incapCookies,
      rawCookies.map(c => c.split(';')[0]).join('; ')
    ].filter(Boolean).join('; ');

    const HEADERS_ALL = { ...HEADERS, Cookie: allCookies };

    for (const c of phoneCandidates) {
      try {
        const r = await fetchJ(API_URL, {
              method: 'POST', headers: HEADERS_ALL,
          body: JSON.stringify({ operationName: 'Probe', query: c.query, variables: c.vars }),
        });
        const t = await r.text();
        probeResults[c.field] = JSON.parse(t);
      } catch (e) {
        probeResults[c.field] = { error: e.message };
      }
    }

    // Probe : xSLoginPhones comme MUTATION (pas query)
    try {
      const rm = await fetchJ(API_URL, {
          method: 'POST', headers: HEADERS_ALL,
        body: JSON.stringify({
          operationName: 'MutPhones',
          query: `mutation MutPhones($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!) {
            xSLoginPhones(id:$id,country:$country,lang:$lang,callby:$callby,user:$user) {
              res msg phones { index phone __typename } __typename
            }
          }`,
          variables: baseVars,
        }),
      });
      probeResults['xSLoginPhones_mutation'] = JSON.parse(await rm.text());
    } catch(e) {
      probeResults['xSLoginPhones_mutation'] = { error: e.message };
    }

    // Probe : xSRequestOtp directement avec phoneIndex 0 (skip phones list)
    try {
      const rr = await fetchJ(API_URL, {
          method: 'POST', headers: HEADERS_ALL,
        body: JSON.stringify({
          operationName: 'ProbeRequestOtp',
          query: `mutation ProbeRequestOtp($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!,$phoneIndex:Int!) {
            xSRequestOtp(id:$id,country:$country,lang:$lang,callby:$callby,user:$user,phoneIndex:$phoneIndex) {
              res msg hash __typename
            }
          }`,
          variables: { ...baseVars, phoneIndex: 0 },
        }),
      });
      probeResults['xSRequestOtp_direct'] = JSON.parse(await rr.text());
    } catch(e) {
      probeResults['xSRequestOtp_direct'] = { error: e.message };
    }

    // Probe : xSVerifyOTP directement avec otp bidon pour voir le vrai schéma attendu
    try {
      const rv = await fetchJ(API_URL, {
          method: 'POST', headers: HEADERS_ALL,
        body: JSON.stringify({
          operationName: 'ProbeVerify',
          query: `mutation ProbeVerify($id:String!,$country:String!,$lang:String!,$callby:String!,$user:String!,$otp:String!) {
            xSVerifyOTP(id:$id,country:$country,lang:$lang,callby:$callby,user:$user,otp:$otp) {
              res msg __typename
            }
          }`,
          variables: { ...baseVars, otp: '000000' },
        }),
      });
      probeResults['xSVerifyOTP_direct'] = JSON.parse(await rv.text());
    } catch(e) {
      probeResults['xSVerifyOTP_direct'] = { error: e.message };
    }

    return {
      step: 'debug',
      loginResult: j1?.data?.xSLoginToken,
      allLoginTokenResponseHeaders: allResponseHeaders,
      incapCookies: incapCookies || 'aucun',
      cookiesReceived: rawCookies.map(c => c.split(';')[0]),
      allCookiesSent: allCookies,
      probeResults,
    };
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  _registerFlowActions() {
    const refreshAction = this.homey.flow.getActionCard('refresh_now');
    refreshAction.registerRunListener(async () => {
      await this.poller.pollNow();
      return true;
    });
  }

  _onSettingChanged(key) {
    if (key === 'poll_interval_min') {
      const intervalMin = Math.max(30, parseInt(this.homey.settings.get('poll_interval_min') || '30'));
      this.poller.setInterval(intervalMin * 60 * 1000);
    }
  }
}

module.exports = VerisureApp;
