'use strict';

const fetch            = require('node-fetch');
const { CookieJar }   = require('tough-cookie');
const https            = require('https');

const API_URL = 'https://customers.securitasdirect.fr/owa-api/graphql';
const COUNTRY = 'FR';
const LANG    = 'fr';
const CALLBY  = 'OWP_10';

const BASE_HEADERS = {
  'Content-Type':      'application/json',
  'Accept':            '*/*',
  'app-origin':        'web',
  'app-version':       'n/a',
  'app-version-code':  '2.2.2',
  'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

function makeSessionId(user) {
  const now = new Date();
  const dt  = `${now.getFullYear()}${now.getMonth()+1}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  const pad = '_'.repeat(Math.max(0, 15 - user.length));
  return `OWP_______________${user}${pad}_______________${dt}`;
}

/**
 * VerisureClient — Flow MFA complet (3 étapes) :
 *
 *  Étape 1 : initiateLogin(email, password)
 *    → mutation xSLoginToken
 *    → retourne { hash, phones: [{ phone, index }] }
 *    → l'UI affiche la liste des téléphones masqués
 *
 *  Étape 2 : requestOtp(phoneIndex)
 *    → mutation xSRequestOtp
 *    → envoie le SMS au téléphone choisi
 *
 *  Étape 3 : confirmMfa(otpCode)
 *    → mutation xSVerifyOTP
 *    → valide le code, persiste la session
 */
class VerisureClient {

  constructor({ homey, email, password }) {
    this.homey           = homey;
    this._email          = email    || null;
    this._password       = password || null;
    this._cookies        = [];
    this._incapCookies   = []; // cookies Incapsula WAF
    this._hash           = null;
    this._sessionId      = null;
    this._giid           = null;

    // CookieJar + agent HTTP persistant
    this._jar   = new CookieJar();
    this._agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 5 });

    // Auth tokens
    this._authHash  = null;   // JWT final (post-MFA)
    this._capabToken = null;   // JWT capabilities (x-capabilities header)
    this._otpHash   = null;   // hash intermédiaire (xSValidateDevice → xSSendOtp)
    this._numinst   = null;   // numéro d'installation (ex: 386019)
    this._panel     = null;
    this._loginTs   = null;   // timestamp du login
  }

  // ── Header auth JSON (format découvert par inspection du trafic réel) ──
  _authHeader() {
    // Pendant le flow MFA : utiliser otpHash. Après login : utiliser authHash.
    const hash = this._authHash || this._otpHash;
    if (!hash) return {};

    // CRITIQUE : le sessionId doit rester constant pour toute la session
    // Ne JAMAIS en générer un nouveau dynamiquement après le login
    let sessionId = this._sessionId;
    if (!sessionId) {
      // Fallback : lire depuis les settings persistés
      sessionId = this.homey.settings.get('verisure_session_id');
      if (sessionId) {
        this._sessionId = sessionId; // restaurer en mémoire
        this.homey.log('[VerisureClient] sessionId restauré depuis settings:', sessionId.slice(0, 40));
      } else {
        // Dernier recours : générer un nouveau (mais log d'avertissement)
        sessionId = makeSessionId(this._email || 'user');
        this._sessionId = sessionId;
        this.homey.log('[VerisureClient] ⚠️ sessionId généré dynamiquement — session instable possible');
      }
    }

    const authObj = {
      loginTimestamp: this._loginTs || parseInt(this.homey.settings.get('verisure_login_ts') || '0') || Date.now(),
      user:           this._email   || this.homey.settings.get('verisure_email') || '',
      id:             sessionId,
      country:        'FR',
      lang:           'fr',
      callby:         'OWP_10',
      hash:           hash,
    };
    return { 'auth': JSON.stringify(authObj) };
  }

  // ── Headers complets pour une requête authentifiée ────────────────────
  _fullHeaders() {
    const h = { ...BASE_HEADERS, ...this._authHeader() };
    if (this._numinst) {
      h['numinst']              = String(this._numinst);
      h['x-installationNumber'] = String(this._numinst);
    }
    if (this._panel)      h['panel']          = this._panel;
    if (this._capabToken) h['x-capabilities'] = this._capabToken;
    return h;
  }

  // ── Fetch avec cookie jar + cookies manuels des settings ─────────────
  async _fetchWithJar(url, options) {
    const jarCookies    = await this._jar.getCookieString(url);
    const manualCookies = this.homey.settings.get('verisure_cookies') || '';
    // Ne pas inclure les valeurs sentinelles non-cookie
    const isRealCookies = manualCookies && manualCookies !== 'active' && manualCookies !== 'browser-session';
    const allCookies    = [jarCookies, isRealCookies ? manualCookies : ''].filter(Boolean).join('; ');

    const headers = { ...(options.headers || {}) };
    if (allCookies) headers['Cookie'] = allCookies;

    const res = await fetch(url, { ...options, headers });

    // Stocker les Set-Cookie dans le jar
    const setCookies = res.headers.raw()['set-cookie'] || [];
    await Promise.all(setCookies.map(c => this._jar.setCookie(c, url).catch(() => {})));

    return res;
  }

  static fromSettings({ homey }) {
    const instance = new VerisureClient({ homey });
    instance._restoreSession();
    if (!instance._authHash) {
      throw new Error("Aucune session Verisure — connectez-vous d'abord dans les réglages");
    }
    return instance;
  }

  // ---------------------------------------------------------------------------
  // Initialisation de la session Incapsula (WAF challenge)
  // ---------------------------------------------------------------------------

  async _initIncapsulaSession() {
    // Un GET sur la page d'accueil Verisure résout le challenge Incapsula
    // et retourne les cookies visid_incap + incap_ses nécessaires pour les
    // requêtes suivantes protégées par le WAF.
    try {
      const res = await this._fetchWithJar('https://customers.securitasdirect.fr/owa-static/login', {
        agent:   this._agent,
        method:  'GET',
        headers: {
          'User-Agent': BASE_HEADERS['User-Agent'],
          'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        },
        redirect: 'follow',
      });

      const setCookies = res.headers.raw()['set-cookie'] || [];
      this._incapCookies = setCookies.map(c => c.split(';')[0]);
      this.homey.log(`[VerisureClient] Incapsula session init: ${this._incapCookies.length} cookie(s) reçus`);
      this.homey.log('[VerisureClient] Incapsula cookies:', this._incapCookies.join('; '));
    } catch (err) {
      this.homey.log('[VerisureClient] _initIncapsulaSession erreur (non bloquant):', err.message);
    }
  }

  _allCookies() {
    return [...this._incapCookies, ...this._cookies]
      .filter(Boolean)
      .join('; ');
  }

  // ---------------------------------------------------------------------------
  // Étape 1 : xSValidateDevice → xSLoginPhones
  // ---------------------------------------------------------------------------

  async initiateLogin(email, password) {
    this._email     = email;
    this._password  = password;
    this._sessionId = makeSessionId(email);
    this._loginTs   = Date.now();

    this.homey.log('[VerisureClient] Étape 1 — xSValidateDevice');

    // xSValidateDevice — auth avec hash:null (début de session, pas encore de JWT)
    const authNullHash = JSON.stringify({
      loginTimestamp: this._loginTs,
      user:           this._email,
      id:             this._sessionId,
      country:        'FR',
      lang:           'fr',
      callby:         'OWP_10',
      hash:           null,
    });
    const validateHeaders = { ...BASE_HEADERS, 'auth': authNullHash };

    const validateRes = await this._fetchWithJar(API_URL, {
      agent:  this._agent,
      method: 'POST',
      headers: validateHeaders,
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

    const validateJson = await validateRes.json();
    this.homey.log('[VerisureClient] xSValidateDevice :', JSON.stringify(validateJson).slice(0, 400));

    // xSValidateDevice retourne un SecurityError avec auth-otp-hash + auth-phones
    // quand le MFA est requis — c'est la réponse NORMALE pour les comptes avec MFA
    const err0 = validateJson.errors?.[0];
    if (err0?.name === 'SecurityError' && err0?.data?.['auth-otp-hash']) {
      this._otpHash = err0.data['auth-otp-hash'];
      // auth-phones : [{ id, phone }] — on les retourne directement
      const authPhones = err0.data['auth-phones'] || [];
      this.homey.log(`[VerisureClient] SecurityError MFA — ${authPhones.length} téléphone(s), otpHash reçu`);

      // Persister
      await this.homey.settings.set('verisure_pending_otp_hash',   this._otpHash);
      await this.homey.settings.set('verisure_otp_for_validate',   this._otpHash);
      await this.homey.settings.set('verisure_pending_session_id', this._sessionId);
      await this.homey.settings.set('verisure_pending_email',      this._email);
      await this.homey.settings.set('verisure_pending_password',   this._password || '');
      await this.homey.settings.set('verisure_pending_login_ts',   String(this._loginTs));

      // Retourner les téléphones directement — pas besoin d'appeler xSLoginPhones
      const phones = authPhones.map(p => ({ index: p.id, phone: p.phone }));
      this.homey.log(`[VerisureClient] Téléphones : ${JSON.stringify(phones)}`);
      return phones;
    }

    // Erreur réelle (mauvais mot de passe, etc.)
    if (validateJson.errors?.length) {
      throw new Error(err0?.message || 'xSValidateDevice échoué');
    }

    // Cas sans MFA (improbable mais géré)
    const vResult = validateJson.data?.xSValidateDevice;
    if (!vResult || vResult.res !== 'OK') {
      throw new Error(vResult?.msg || 'Identifiants incorrects.');
    }
    this._otpHash = vResult.hash;
    this.homey.log('[VerisureClient] otpHash reçu (sans MFA):', this._otpHash ? 'oui' : 'non');

    // Persister pour les étapes suivantes
    await this.homey.settings.set('verisure_pending_otp_hash',   this._otpHash);
    await this.homey.settings.set('verisure_pending_session_id', this._sessionId);
    await this.homey.settings.set('verisure_pending_email',      this._email);
    await this.homey.settings.set('verisure_pending_password',   this._password || '');

    // Fallback : appeler xSLoginPhones si on n'a pas eu les téléphones via SecurityError
    const phones = await this._getPhones();
    this.homey.log(`[VerisureClient] ${phones.length} téléphone(s)`);
    return phones;
  }

  // ---------------------------------------------------------------------------
  // Étape 2 : xSSendOtp(recordId, otpHash)
  // ---------------------------------------------------------------------------

  async requestOtp(phoneIndex) {
    if (!this._otpHash) {
      this._otpHash   = this.homey.settings.get('verisure_pending_otp_hash');
      this._sessionId = this.homey.settings.get('verisure_pending_session_id');
      this._email     = this.homey.settings.get('verisure_pending_email');
    }
    if (!this._otpHash) throw new Error('Session expirée. Recommencez depuis le début.');

    // recordId = phoneIndex (index du téléphone sélectionné)
    this.homey.log(`[VerisureClient] Étape 2 — xSSendOtp (recordId: ${phoneIndex})`);

    const res = await this._fetchWithJar(API_URL, {
      agent:  this._agent,
      method: 'POST',
      headers: this._fullHeaders(),
      body: JSON.stringify({
        operationName: 'mkSendOTP',
        query: `mutation mkSendOTP($recordId:Int!,$otpHash:String!) {
          xSSendOtp(recordId:$recordId,otpHash:$otpHash) {
            res msg __typename
          }
        }`,
        variables: { recordId: parseInt(phoneIndex, 10), otpHash: this._otpHash },
      }),
    });

    const json = await res.json();
    this.homey.log('[VerisureClient] xSSendOtp :', JSON.stringify(json).slice(0, 200));
    if (json.errors?.length) throw new Error(json.errors[0]?.data?.reason || json.errors[0].message);

    const result = json.data?.xSSendOtp;
    if (!result || result.res !== 'OK') throw new Error(result?.msg || 'Impossible d\'envoyer le SMS.');

    this.homey.log('[VerisureClient] SMS envoyé');
  }

  // ---------------------------------------------------------------------------
  // Étape 3 : xSVerifyOTP
  // ---------------------------------------------------------------------------

  async confirmMfa(otpCode) {
    // Toujours recharger depuis les settings pour garantir la cohérence
    // verisure_otp_for_validate = otpHash sauvegardé AVANT mkSendOTP (clé pour la validation)
    const otpForValidate = this.homey.settings.get('verisure_otp_for_validate')
                        || this.homey.settings.get('verisure_pending_otp_hash');
    if (otpForValidate) this._otpHash = otpForValidate;
    if (!this._sessionId) this._sessionId = this.homey.settings.get('verisure_pending_session_id');
    if (!this._email)     this._email     = this.homey.settings.get('verisure_pending_email');
    if (!this._password)  this._password  = this.homey.settings.get('verisure_pending_password');
    if (!this._loginTs)   this._loginTs   = parseInt(this.homey.settings.get('verisure_pending_login_ts') || '0') || Date.now();
    if (!this._otpHash) throw new Error('Session expirée. Recommencez depuis le début.');

    this.homey.log('[VerisureClient] Étape 3 — mkValidateDevice + header security (OTP)');

    // Header auth avec hash:null (comme le site)
    const authObj = JSON.stringify({
      loginTimestamp: this._loginTs,
      user:           this._email,
      id:             this._sessionId,
      country:        'FR',
      lang:           'fr',
      callby:         'OWP_10',
      hash:           null,
    });

    // Header security avec le code OTP saisi par l'utilisateur
    const securityObj = JSON.stringify({
      token:   otpCode,
      type:    'OTP',
      otpHash: this._otpHash,
    });

    const headers = {
      ...BASE_HEADERS,
      'auth':     authObj,
      'security': securityObj,
      'numinst':  String(this._numinst || this.homey.settings.get('verisure_numinst') || ''),
      'panel':    this._panel || this.homey.settings.get('verisure_panel') || '',
    };

    const res = await this._fetchWithJar(API_URL, {
      agent:  this._agent,
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationName: 'mkValidateDevice',
        query: `mutation mkValidateDevice($password:String) {
          xSValidateDevice(password:$password) {
            res msg hash refreshToken legals __typename
          }
        }`,
        variables: { password: this._password || '' },
      }),
    });

    const json = await res.json();
    this.homey.log('[VerisureClient] mkValidateDevice (confirmMfa) :', JSON.stringify(json).slice(0, 300));

    const err0 = json.errors?.[0];
    if (err0?.name === 'SecurityError') throw new Error('Code OTP incorrect ou expiré.');
    if (json.errors?.length) throw new Error(err0?.message || 'Erreur validation MFA');

    const result = json.data?.xSValidateDevice;
    if (!result || result.res !== 'OK') throw new Error(result?.msg || 'Code OTP incorrect.');
    if (result.hash) { this._authHash = result.hash; } // loginTs reste celui du login initial
    // Sauvegarder le refreshToken (valide ~2 ans)
    if (result.refreshToken) {
      await this.homey.settings.set('verisure_refresh_token', result.refreshToken);
      this.homey.log('[VerisureClient] refreshToken sauvegardé');
    }

    this.homey.log('[VerisureClient] ✅ MFA validé — JWT reçu');

    this._otpHash = null;
    // NE PAS effacer _sessionId — le serveur en a besoin pour les requêtes suivantes
    // this._sessionId = null;  ← SUPPRIMÉ

    await this.homey.settings.unset('verisure_pending_otp_hash');
    await this.homey.settings.unset('verisure_otp_for_validate');
    await this.homey.settings.unset('verisure_pending_session_id');
    await this.homey.settings.unset('verisure_pending_email');
    await this.homey.settings.unset('verisure_pending_password');
    await this.homey.settings.unset('verisure_pending_login_ts');

    await this._initGiid();
    await this._saveSession();

    this.homey.log('[VerisureClient] MFA validé — session persistée');
  }

  // ---------------------------------------------------------------------------
  // Helper : récupérer la liste des téléphones via xSLoginPhones
  // Retourne [{ index: recordId, phone: '+33 6 ** ** 12' }]
  // ---------------------------------------------------------------------------

  async _getPhones() {
    try {
      const res = await this._fetchWithJar(API_URL, {
        agent:  this._agent,
        method: 'POST',
        headers: this._fullHeaders(),
        body: JSON.stringify({
          operationName: 'xSLoginPhones',
          query: `query xSLoginPhones($id:String!,$user:String!,$lang:String!,$country:String!) {
            xSLoginPhones(id:$id,user:$user,lang:$lang,country:$country) {
              res msg phones { index phone __typename } __typename
            }
          }`,
          variables: {
            id:      this._sessionId,
            user:    this._email,
            lang:    LANG,
            country: COUNTRY,
          },
        }),
      });
      const json = await res.json();
      this.homey.log('[VerisureClient] xSLoginPhones :', JSON.stringify(json).slice(0, 300));
      const phones = json?.data?.xSLoginPhones?.phones || [];
      if (phones.length > 0) return phones.map(p => ({ index: p.index, phone: p.phone }));
    } catch(e) {
      this.homey.log('[VerisureClient] _getPhones erreur :', e.message);
    }
    // Fallback si xSLoginPhones échoue — index 0 par défaut
    return [{ index: 0, phone: 'Téléphone enregistré' }];
  }


  async _initGiid() {
    // Stratégie 1 : xSSrv avec le numinst connu (fonctionne pour comptes secondaires)
    const knownNuminst = this._numinst
      || this.homey.settings.get('verisure_numinst')
      || this.homey.settings.get('verisure_giid');

    if (knownNuminst) {
      try {
        const res = await this._fetchWithJar(API_URL, {
          agent: this._agent, method: 'POST', headers: this._fullHeaders(),
          body: JSON.stringify({
            operationName: 'Srv',
            query: `query Srv($numinst: String!) {
              xSSrv(numinst: $numinst) {
                res
                installation { numinst alias panel role capabilities name surname address city postcode __typename }
                __typename
              }
            }`,
            variables: { numinst: knownNuminst },
          }),
        });
        const json = await res.json();
        const srv  = json?.data?.xSSrv;
        if (srv?.res === 'OK' && srv?.installation) {
          const inst = srv.installation;
          this._giid    = String(inst.numinst);
          this._numinst = String(inst.numinst);
          this._panel   = inst.panel || '';
          if (inst.capabilities) {
            this._capabToken = inst.capabilities;
            await this.homey.settings.set('verisure_capab_token', inst.capabilities);
          }
          const alias   = inst.alias || '';
          const address = [inst.address, inst.city, inst.postcode].filter(Boolean).join(', ');
          const owner   = [inst.name, inst.surname].filter(Boolean).join(' ');
          await this.homey.settings.set('verisure_giid',    this._giid);
          await this.homey.settings.set('verisure_numinst', this._numinst);
          await this.homey.settings.set('verisure_panel',   this._panel);
          if (alias)   await this.homey.settings.set('verisure_alias',   alias);
          if (address) await this.homey.settings.set('verisure_address', address);
          if (owner)   await this.homey.settings.set('verisure_owner',   owner);
          this.homey.log(`[VerisureClient] xSSrv OK — ${alias} | numinst: ${inst.numinst}`);
          return;
        }
        this.homey.log('[VerisureClient] xSSrv échec (numinst=' + knownNuminst + '):', JSON.stringify(json).slice(0, 300));
      } catch(e) {
        this.homey.log('[VerisureClient] xSSrv erreur:', e.message);
      }
    } else {
      this.homey.log('[VerisureClient] _initGiid: numinst inconnu — passage direct à xSInstallations');
    }

    // Stratégie 2 : xSInstallations (fonctionne pour compte principal/OWNER)
    const res2 = await this._fetchWithJar(API_URL, {
      agent: this._agent, method: 'POST', headers: this._fullHeaders(),
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
    const json2 = await res2.json();
    this.homey.log('[VerisureClient] xSInstallations réponse:', JSON.stringify(json2).slice(0, 300));
    const list  = json2?.data?.xSInstallations?.installations ?? [];
    if (!list.length) throw new Error('Aucune installation Verisure trouvée (xSSrv et xSInstallations ont échoué)');

    const inst      = list[0];
    const installId = inst.numinst;
    this._giid    = String(installId);
    this._numinst = String(installId);
    this._panel   = inst.panel || '';
    const alias   = inst.alias || inst.name || '';
    const address = [inst.address, inst.city, inst.postcode].filter(Boolean).join(', ');
    const owner   = [inst.name, inst.surname].filter(Boolean).join(' ');
    await this.homey.settings.set('verisure_giid',    this._giid);
    await this.homey.settings.set('verisure_numinst', this._numinst);
    await this.homey.settings.set('verisure_panel',   this._panel);
    if (address) await this.homey.settings.set('verisure_address', address);
    if (owner)   await this.homey.settings.set('verisure_owner',   owner);
    this.homey.log(`[VerisureClient] xSInstallations OK — ${alias} | numinst: ${installId}`);

    // Appeler xSSrv avec le numinst maintenant connu pour obtenir le capabilities token
    try {
      const res3 = await this._fetchWithJar(API_URL, {
        agent: this._agent, method: 'POST', headers: this._fullHeaders(),
        body: JSON.stringify({
          operationName: 'Srv',
          query: `query Srv($numinst: String!) {
            xSSrv(numinst: $numinst) {
              res installation { capabilities __typename } __typename
            }
          }`,
          variables: { numinst: String(installId) },
        }),
      });
      const json3  = await res3.json();
      const cap    = json3?.data?.xSSrv?.installation?.capabilities;
      if (cap) {
        this._capabToken = cap;
        await this.homey.settings.set('verisure_capab_token', cap);
        this.homey.log('[VerisureClient] ✅ capabilities token obtenu via xSSrv post-Installations');
      } else {
        this.homey.log('[VerisureClient] xSSrv post-Installations — pas de capabilities:', JSON.stringify(json3).slice(0, 200));
      }
    } catch(e) {
      this.homey.log('[VerisureClient] xSSrv post-Installations erreur:', e.message);
    }
  }

  async _ensureNuminst() {
    if (this._numinst) return;
    this._numinst = this.homey.settings.get('verisure_numinst');
    if (!this._numinst) await this._initGiid();
    if (!this._capabToken) {
      this._capabToken = this.homey.settings.get('verisure_capab_token') || null;
      if (!this._capabToken) await this._fetchCapabilities();
    }
  }

  async _fetchCapabilities() {
    try {
      const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
      // xSSrv retourne installation.capabilities = token x-capabilities
      const res = await this._fetchWithJar(API_URL, {
        agent:   this._agent,
        method:  'POST',
        headers: { ...BASE_HEADERS, ...this._authHeader(),
                   numinst: String(numinst), panel: this._panel || '' },
        body: JSON.stringify({
          operationName: 'Srv',
          query: `query Srv($numinst: String!) {
            xSSrv(numinst: $numinst) {
              res installation { numinst alias panel capabilities __typename } __typename
            }
          }`,
          variables: { numinst },
        }),
      });
      const json  = await res.json();
      const token = json?.data?.xSSrv?.installation?.capabilities;
      if (token) {
        this._capabToken = token;
        await this.homey.settings.set('verisure_capab_token', token);
        this.homey.log('[VerisureClient] x-capabilities token obtenu via xSSrv');
        return true;
      }
      this.homey.log('[VerisureClient] _fetchCapabilities — pas de token dans xSSrv:', JSON.stringify(json).slice(0,200));
    } catch(e) {
      this.homey.log('[VerisureClient] _fetchCapabilities erreur:', e.message);
    }
    return false;
  }

  // Vérifie si le JWT est expiré et le rafraîchit uniquement si nécessaire.
  // Appelé avant chaque requête _gql — ne fait un appel réseau QUE si le JWT
  // est déjà expiré ou expire dans moins de 2 min (marge de sécurité minimale).
  async _ensureFreshToken() {
    try {
      const hash = this._authHash || this.homey.settings.get('verisure_auth_hash');
      if (!hash) return;

      const payload = hash.split('.')[1];
      if (!payload) return; // hash opaque non-JWT → pas de vérification possible

      try {
        const pad  = payload + '='.repeat((4 - payload.length % 4) % 4);
        const data = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
        const expiresIn = (data.exp * 1000) - Date.now();

        // Rafraîchir uniquement si expiré ou expire dans moins de 2 min
        // Le JWT dure ~15 min — avec un poll toutes les 30 min, _gql gère
        // le refresh automatique via le catch 401. Ce code est une sécurité
        // pour éviter d'envoyer une requête avec un JWT déjà expiré.
        if (expiresIn < 2 * 60 * 1000) {
          this.homey.log(`[VerisureClient] JWT expiré ou imminent (${Math.round(expiresIn/1000)}s) — refresh`);
          await this._refreshSession();
        }
        // Sinon : JWT encore valide, aucun appel réseau
      } catch(parseErr) {
        // JWT non décodable → ne pas rafraîchir proactivement
        // Le catch 401 dans _gql prendra le relais si besoin
      }
    } catch(e) {
      this.homey.log('[VerisureClient] _ensureFreshToken erreur:', e.message);
    }
  }

  // Alias pour compatibilité
  async _ensureGiid() { return this._ensureNuminst(); }

  async _gql({ operationName, query, variables }) {
    await this._ensureNuminst();
    const vars = variables ? variables : (query.includes('$numinst') ? { numinst: this._numinst } : (query.includes('$giid') ? { giid: this._numinst } : undefined));
    const bodyStr = JSON.stringify({ operationName, query, variables: vars });
    const res = await this._fetchWithJar(API_URL, {
      agent:   this._agent,
      method:  'POST',
      headers: this._fullHeaders(),
      body:    bodyStr,
    });
    const json = await res.json();

    // Session expirée → tenter un refresh automatique (une seule fois)
    const err0 = json.errors?.[0];
    if (res.status === 401 || err0?.name === 'ExpiredSessionError' || err0?.message?.includes('Invalid session')) {
      this.homey.log('[VerisureClient] Session expirée — tentative refresh token');
      const refreshed = await this._refreshSession();
      if (refreshed) {
        // Réessayer la requête avec le nouveau hash
        const res2 = await this._fetchWithJar(API_URL, {
          agent:   this._agent,
          method:  'POST',
          headers: this._fullHeaders(),
          body:    bodyStr,
        });
        const json2 = await res2.json();
        if (json2.errors?.length) throw new Error(json2.errors[0].message || 'Erreur GraphQL après refresh');
        return json2.data;
      }
      await this.homey.notifications.createNotification({
        excerpt: 'Verisure : session expirée. Reconnectez-vous dans les réglages.',
      }).catch(() => {});
      throw new Error('Session Verisure expirée — reconnexion requise');
    }

    if (json.errors && json.errors.length) {
      // accessPermissions = JWT expiré ou droits insuffisants → tenter refresh
      if (err0?.name === 'accessPermissionsMiddleware' || err0?.reason?.includes('accessPermissions')) {
        this.homey.log('[VerisureClient] accessPermissions — tentative refresh pour', operationName);
        const refreshed = await this._refreshSession();
        if (refreshed) {
          const res3 = await this._fetchWithJar(API_URL, {
            agent: this._agent, method: 'POST',
            headers: this._fullHeaders(), body: bodyStr,
          });
          const json3 = await res3.json();
          if (json3.errors?.length) {
            this.homey.log('[VerisureClient] accessPermissions après refresh — droits insuffisants pour', operationName);
            return null;
          }
          return json3.data;
        }
        this.homey.log('[VerisureClient] accessPermissions — refresh impossible pour', operationName);
        return null;
      }
      throw new Error(json.errors[0].message || 'Erreur GraphQL');
    }
    return json.data;
  }

  async _refreshSession() {
    // Stratégie 1 : appeler xSSrv avec le JWT actuel + cookies existants
    // → si les cookies Incapsula sont encore valides, xSSrv retournera OK
    //   et on récupère un nouveau capabilities token
    // Stratégie 2 : si stratégie 1 échoue, essayer avec le refreshToken comme hash
    // Stratégie 3 : si tout échoue, retourner false → session.expired
    this.homey.log('[VerisureClient] Tentative refresh session...');

    const numinst        = this._numinst || this.homey.settings.get('verisure_numinst') || '';
    const panel          = this._panel   || this.homey.settings.get('verisure_panel')   || '';
    const sessionId      = this._sessionId || this.homey.settings.get('verisure_session_id');
    const loginTs        = this._loginTs   || parseInt(this.homey.settings.get('verisure_login_ts') || '0') || Date.now();
    const email          = this._email     || this.homey.settings.get('verisure_email') || '';
    const refreshToken   = this.homey.settings.get('verisure_refresh_token');

    const makeSrvBody = (hash) => JSON.stringify({
      operationName: 'Srv',
      query: `query Srv($numinst: String!) {
        xSSrv(numinst: $numinst) {
          res installation { capabilities __typename } __typename
        }
      }`,
      variables: { numinst },
    });

    const makeHeaders = (hash) => ({
      ...BASE_HEADERS,
      auth: JSON.stringify({ loginTimestamp: loginTs, user: email, id: sessionId, country: 'FR', lang: 'fr', callby: 'OWP_10', hash }),
      numinst: String(numinst), panel, 'x-installationNumber': String(numinst),
    });

    const trySrv = async (hash, label) => {
      try {
        const res  = await this._fetchWithJar(API_URL, { agent: this._agent, method: 'POST', headers: makeHeaders(hash), body: makeSrvBody(hash) });
        const json = await res.json();
        const srv  = json?.data?.xSSrv;
        if (srv?.res === 'OK') {
          this.homey.log(`[VerisureClient] ✅ Session rafraîchie (${label})`);
          // Mettre à jour le hash actif
          this._authHash = hash;
          await this.homey.settings.set('verisure_auth_hash', hash);
          // Renouveler le capabilities token
          const cap = srv.installation?.capabilities;
          if (cap) {
            this._capabToken = cap;
            await this.homey.settings.set('verisure_capab_token', cap);
          }
          return true;
        }
        this.homey.log(`[VerisureClient] xSSrv (${label}) → ${JSON.stringify(json).slice(0, 150)}`);
      } catch(e) {
        this.homey.log(`[VerisureClient] xSSrv (${label}) erreur: ${e.message}`);
      }
      return false;
    };

    // Stratégie 1 : JWT courant + cookies
    const currentHash = this._authHash || this.homey.settings.get('verisure_auth_hash');
    if (currentHash && await trySrv(currentHash, 'JWT courant + cookies')) return true;

    // Stratégie 2 : refreshToken comme hash
    if (refreshToken && refreshToken !== currentHash) {
      if (await trySrv(refreshToken, 'refreshToken')) return true;
    }

    // Stratégie 3 : xSRefreshLogin avec refreshToken + paramètres device
    if (refreshToken) {
      try {
        const savedSessionId = this._sessionId || this.homey.settings.get('verisure_session_id') || '';
        const res3 = await this._fetchWithJar(API_URL, {
          agent: this._agent, method: 'POST',
          headers: makeHeaders(refreshToken),
          body: JSON.stringify({
            operationName: 'RefreshLogin',
            query: `mutation RefreshLogin($refreshToken:String!, $id:String!, $country:String!, $lang:String!, $callby:String!, $idDevice:String!, $idDeviceIndigitall:String!, $deviceType:String!, $deviceVersion:String!, $deviceResolution:String!, $deviceName:String!, $deviceBrand:String!, $deviceOsVersion:String!, $uuid:String!) {
              xSRefreshLogin(refreshToken:$refreshToken, id:$id, country:$country, lang:$lang, callby:$callby, idDevice:$idDevice, idDeviceIndigitall:$idDeviceIndigitall, deviceType:$deviceType, deviceVersion:$deviceVersion, deviceResolution:$deviceResolution, deviceName:$deviceName, deviceBrand:$deviceBrand, deviceOsVersion:$deviceOsVersion, uuid:$uuid) {
                res msg hash refreshToken legals changePassword needDeviceAuthorization mainUser __typename
              }
            }`,
            variables: {
              refreshToken,
              id: savedSessionId,
              country: 'FR', lang: 'fr', callby: 'OWP_10',
              idDevice: 'homey', idDeviceIndigitall: 'homey',
              deviceType: 'homey', deviceVersion: '1.0.0',
              deviceResolution: '1920x1080', deviceName: 'Homey Pro',
              deviceBrand: 'Athom', deviceOsVersion: '12.0.0',
              uuid: savedSessionId,
            },
          }),
        });
        const json3 = await res3.json();
        const r3 = json3?.data?.xSRefreshLogin;
        if (r3?.res === 'OK' && r3?.hash) {
          this.homey.log('[VerisureClient] ✅ Session rafraîchie via xSRefreshLogin');
          this._authHash = r3.hash;
          await this.homey.settings.set('verisure_auth_hash', r3.hash);
          if (r3.refreshToken) await this.homey.settings.set('verisure_refresh_token', r3.refreshToken);
          return true;
        }
        this.homey.log('[VerisureClient] xSRefreshLogin échoué:', JSON.stringify(json3).slice(0, 150));
      } catch(e3) {
        this.homey.log('[VerisureClient] xSRefreshLogin erreur:', e3.message);
      }
    }

    this.homey.log('[VerisureClient] ❌ Toutes les stratégies de refresh ont échoué');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Queries métier (inchangées)
  // ---------------------------------------------------------------------------

  // ── Persistance session ─────────────────────────────────────────────────

  async _saveSession() {
    try {
      await this.homey.settings.set('verisure_auth_hash',  this._authHash  || '');
      await this.homey.settings.set('verisure_login_ts',   String(this._loginTs || Date.now()));
      await this.homey.settings.set('verisure_email',      this._email     || '');
      await this.homey.settings.set('verisure_cookies',    'active');
      // Sauvegarder le sessionId — CRITIQUE : le serveur exige le même sessionId
      if (this._sessionId) await this.homey.settings.set('verisure_session_id', this._sessionId);
      if (this._giid)    await this.homey.settings.set('verisure_giid',    this._giid);
      if (this._numinst) await this.homey.settings.set('verisure_numinst', String(this._numinst));
      if (this._panel)   await this.homey.settings.set('verisure_panel',   this._panel);
      // Sauvegarder les cookies Incapsula — nécessaires pour que le serveur accepte les requêtes
      try {
        const jarStr = JSON.stringify(this._jar.toJSON());
        await this.homey.settings.set('verisure_cookie_jar', jarStr);
      } catch(e2) {}
      this.homey.log('[VerisureClient] Session sauvegardée — sid:', this._sessionId?.slice(0, 30));
    } catch(e) {
      this.homey.log('[VerisureClient] _saveSession erreur :', e.message);
    }
  }

  _restoreSession() {
    try {
      this._authHash  = this.homey.settings.get('verisure_auth_hash')  || null;
      this._loginTs   = parseInt(this.homey.settings.get('verisure_login_ts') || '0') || null;
      this._email     = this.homey.settings.get('verisure_email')      || null;
      this._giid      = this.homey.settings.get('verisure_giid')       || null;
      this._numinst   = this.homey.settings.get('verisure_numinst')    || null;
      this._panel     = this.homey.settings.get('verisure_panel')      || '';
      this._capabToken= this.homey.settings.get('verisure_capab_token')|| null;
      // Restaurer le sessionId sauvegardé — NE PAS en générer un nouveau
      // Si absent, laisser null → _authHeader le lira depuis les settings à la prochaine requête
      this._sessionId = this.homey.settings.get('verisure_session_id') || null;
      // Restaurer les cookies Incapsula
      try {
        const jarStr = this.homey.settings.get('verisure_cookie_jar');
        if (jarStr) {
          this._jar = CookieJar.fromJSON(JSON.parse(jarStr));
          this.homey.log('[VerisureClient] Cookie jar restauré');
        }
      } catch(e2) {}
      if (this._authHash) this.homey.log('[VerisureClient] Session restaurée — email:', this._email, '| sid:', this._sessionId?.slice(0,30));
      else this.homey.log('[VerisureClient] Pas de session sauvegardée');
    } catch(e) {
      this.homey.log('[VerisureClient] _restoreSession erreur :', e.message);
    }
  }

  async clearSession() {
    try {
      await this.homey.settings.unset('verisure_auth_hash');
      await this.homey.settings.unset('verisure_refresh_token');
      await this.homey.settings.unset('verisure_login_ts');
      await this.homey.settings.unset('verisure_session_id');
      await this.homey.settings.unset('verisure_cookie_jar');
      await this.homey.settings.unset('verisure_capab_token');
      await this.homey.settings.unset('verisure_cookies');
      await this.homey.settings.unset('verisure_numinst');
      await this.homey.settings.unset('verisure_giid');
      await this.homey.settings.unset('verisure_panel');
      await this.homey.settings.unset('verisure_owner');
      await this.homey.settings.unset('verisure_address');
      await this.homey.settings.unset('verisure_alias');
      await this.homey.settings.unset('verisure_last_arm_state');
      await this.homey.settings.unset('verisure_sensor_count');
      await this.homey.settings.unset('verisure_last_poll_ts');
      this._authHash = null; this._refreshToken = null;
      this._sessionId = null; this._loginTs = null;
      this._numinst = null; this._panel = null;
      this._capabToken = null;
      this._jar = new CookieJar();
      this.homey.log('[VerisureClient] Session effacée');
    } catch(e) {
      this.homey.log('[VerisureClient] clearSession erreur:', e.message);
    }
  }

  // ── Requêtes API ─────────────────────────────────────────────────────────

  async getDoorWindowSensors() {
    await this._ensureNuminst();
    const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
    const panel   = this._panel   || this.homey.settings.get('verisure_panel') || '';

    // Utiliser xSDeviceList pour lister tous les capteurs de l'installation
    // type: 'XR' = PIR/caméra, type: 'DC'/'MC'/'SC' = contact porte/fenêtre, code: '0' = centrale
    try {
      const data = await this._gql({
        operationName: 'xSDeviceList',
        query: `query xSDeviceList($numinst: String!, $panel: String!) {
          xSDeviceList(numinst: $numinst, panel: $panel) {
            devices { id code zoneId name type isActive serialNumber __typename }
            __typename
          }
        }`,
        variables: { numinst, panel },
      });

      const devices = data?.xSDeviceList?.devices ?? [];
      this.homey.log('[VerisureClient] xSDeviceList — ' + devices.length + ' device(s):', JSON.stringify(devices).slice(0, 500));

      // Types confirmés par sondage :
      // CENT = centrale alarme
      // XR   = PIR avec caméra
      // MG   = détecteur magnétique (contact porte/fenêtre)
      const contactSensors = devices
        .filter(d => d.type === 'MG')
        .map(d => ({
          deviceLabel: 'MG_' + d.code,  // préfixe type pour garantir l'unicité
          area:        d.name || d.code,
          state:       'CLOSE',
          type:        d.type,
          code:        d.code,
          serialNumber: d.serialNumber || null,
          reportTime:  new Date().toISOString(),
        }));

      this.homey.log('[VerisureClient] contacts MG:', contactSensors.length,
        '| PIR XR:', devices.filter(d => d.type === 'XR').length,
        '| centrale CENT:', devices.filter(d => d.type === 'CENT').length);

      return contactSensors;

    } catch(e) {
      this.homey.log('[VerisureClient] getDoorWindowSensors erreur:', e.message);
      return [];
    }
  }

  async getAllDevices() {
    await this._ensureNuminst();
    const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
    const panel   = this._panel   || this.homey.settings.get('verisure_panel') || '';
    const data = await this._gql({
      operationName: 'xSDeviceList',
      query: `query xSDeviceList($numinst: String!, $panel: String!) {
        xSDeviceList(numinst: $numinst, panel: $panel) {
          devices { id code zoneId name type isActive serialNumber __typename }
          __typename
        }
      }`,
      variables: { numinst, panel },
    });
    return data?.xSDeviceList?.devices ?? [];
  }

  // ── Journal d'activité xSActV2 ─────────────────────────────────────────

  async getActV2({ numRows = 30, offset = 0, dateFrom = null, dateTo = null,
                   singleActivityFilter = null, signalsToExclude = null,
                   idDevice = null, alias = null } = {}) {
    await this._ensureNuminst();
    const numinst = this._numinst;
    const panel   = this._panel || '';

    const data = await this._gql({
      operationName: 'ActV2Timeline',
      query: `query ActV2Timeline(
        $numinst: String!,
        $offset: Int,
        $hasLocksmithRequested: Boolean,
        $singleActivityFilter: [Int],
        $signalsToExclude: [Int],
        $timeFilter: TimeFilter!,
        $numRows: Int,
        $dateTo: Datetime,
        $dateFrom: Datetime,
        $idDevice: String,
        $alias: String,
        $panel: String,
        $lix: String
      ) {
        xSActV2(
          numinst: $numinst
          input: {
            timeFilter: $timeFilter,
            numRows: $numRows,
            offset: $offset,
            dateFrom: $dateFrom,
            dateTo: $dateTo,
            singleActivityFilter: $singleActivityFilter,
            signalsToExclude: $signalsToExclude,
            hasLocksmithRequested: $hasLocksmithRequested,
            idDevice: $idDevice,
            alias: $alias,
            panel: $panel,
            lix: $lix
          }
        ) {
          reg {
            alias
            type
            device
            source
            idSignal
            schedulerType
            myVerisureUser
            time
            img
            incidenceId
            signalType
            interface
            deviceName
            keyname
            tagId
            userAuth
            exceptions {
              status
              deviceType
              alias
              __typename
            }
            __typename
          }
          __typename
        }
      }`,
      variables: {
        numinst,
        panel,
        offset,
        numRows,
        timeFilter:            'ALL',
        hasLocksmithRequested: false,
        singleActivityFilter:  singleActivityFilter ?? [0],
        signalsToExclude:      signalsToExclude     ?? [],
        dateFrom:              dateFrom ?? null,
        dateTo:                dateTo   ?? null,
        idDevice:              idDevice ?? null,
        alias:                 alias    ?? null,
        lix:                   null,
      },
    });

    return data?.xSActV2?.reg ?? [];
  }

  // ── Caméras ──────────────────────────────────────────────────────────────

  async getAllCameras(user) {
    await this._ensureNuminst();
    const numinst = this._numinst;
    const u = user || this._email || '';
    const data = await this._gql({
      operationName: 'mkGetAllCameras',
      query: `query mkGetAllCameras($numinst: String!, $user: String!, $lang: String!, $userCameraTypes: [String]) {
        xSGetAllCameras(numinst: $numinst, user: $user, lang: $lang, userCameraTypes: $userCameraTypes) {
          res msg
          cameras { brand model alias serial password
            config { name enabled reason __typename } __typename }
          arlo {
            catalog { brand batteryLevel online connectivity createdDate latestThumbnailUri
              locationHint model modifiedDate serial alias
              config { name enabled reason __typename } __typename }
            custom { brand serial alias model deviceId code type
              config { name enabled reason __typename } __typename }
            __typename
          }
          pir { alias code deviceId type
            config { name enabled reason __typename } __typename }
          vc4 { serial code alias deviceId type
            config { name enabled reason __typename } __typename }
          __typename
        }
      }`,
      variables: { numinst, user: u, lang: 'fr', userCameraTypes: ['PIR Camera'] },
    });
    return data?.xSGetAllCameras ?? null;
  }

  // ── Demande d'images PIR ────────────────────────────────────────────────

  /**
   * Demande une capture d'image à un ou plusieurs détecteurs PIR.
   * @param {number[]} devices - tableau de codes PIR (ex: [10] pour couloir)
   * @param {object}   opts    - mediaType, resolution, deviceType (optionnels)
   * @returns {{ res, msg, referenceId }} — referenceId à utiliser pour le statut
   */
  // ── DIY List (maintenance) ───────────────────────────────────────────────

  async getDIYList() {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'DIYList',
      query: `query DIYList($numinst: String!, $panel: String!) {
        xSDiyList(numinst: $numinst, panel: $panel) {
          res
          DIYList { idMant state __typename }
          noDigitalDIYList { idMant __typename }
          __typename
        }
      }`,
      variables: { numinst: this._numinst, panel: this._panel || 'SDVFAST' },
    });
    return data?.xSDiyList ?? null;
  }

  // ── Clés et télécommandes ────────────────────────────────────────────────

  async getKeys() {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'mkGetKeysRemotesList',
      query: `query mkGetKeysRemotesList($numinst: String!, $panel: String!) {
        xSKeys(numinst: $numinst, panel: $panel) {
          keysList {
            ident lix lixCu keyType activate controlled armType
            alias color serialNumber workOrder cost lostKey
            sendEmail sendPush physicalTechnology security mechanics
            user { idUser label __typename }
            __typename
          }
          __typename
        }
      }`,
      variables: { numinst: this._numinst, panel: this._panel || 'SDVFAST' },
    });
    return data?.xSKeys?.keysList ?? [];
  }

  // ── Incidents de télésurveillance ────────────────────────────────────────

  async getIncidenceList() {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'xSSmartNotificationsIncidenceList',
      query: `query xSSmartNotificationsIncidenceList($numinst: String!) {
        xSSmartNotificationsIncidenceList(numinst: $numinst) {
          incidences { date incidenceNumber open __typename }
          __typename
        }
      }`,
      variables: { numinst: this._numinst },
    });
    return data?.xSSmartNotificationsIncidenceList?.incidences ?? [];
  }

  // ── Planificateur (programmations ARM/DARM) ──────────────────────────────

  async getScheduler() {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'Scheduler',
      query: `query Scheduler($numinst: String!) {
        xSScheduler(numinst: $numinst) {
          scheduleList {
            idSch description action startDate endDate time
            repeat prenotification days active onFly cancel
            postpone postponeTime __typename
          }
          legal notifOnlyKo __typename
        }
      }`,
      variables: { numinst: this._numinst },
    });
    return data?.xSScheduler ?? null;
  }

  // ── Demande d'images PIR ────────────────────────────────────────────────

  async requestImages(deviceCodes, { mediaType, resolution, deviceType } = {}) {
    await this._ensureNuminst();
    const numinst = this._numinst;
    const panel   = this._panel || 'SDVFAST';

    // deviceCodes : tableau d'entiers (code du device XR, ex: [10])
    const devices = Array.isArray(deviceCodes) ? deviceCodes : [deviceCodes];

    const data = await this._gql({
      operationName: 'RequestImages',
      query: `mutation RequestImages(
        $numinst: String!, $panel: String!, $devices: [Int]!,
        $mediaType: Int, $resolution: Int, $deviceType: Int
      ) {
        xSRequestImages(
          numinst: $numinst panel: $panel devices: $devices
          mediaType: $mediaType resolution: $resolution deviceType: $deviceType
        ) {
          res msg referenceId __typename
        }
      }`,
      variables: {
        numinst,
        panel,
        devices,
        mediaType:   mediaType   ?? null,
        resolution:  resolution  ?? null,
        deviceType:  deviceType  ?? null,
      },
    });

    return data?.xSRequestImages ?? null;
  }

  // Polling statut demande d'images — à appeler après requestImages
  async getRequestImagesStatus(referenceId, counter = 1) {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'xSRequestImagesStatus',
      query: `query xSRequestImagesStatus($numinst: String!, $referenceId: String!, $counter: Int!) {
        xSRequestImagesStatus(numinst: $numinst, referenceId: $referenceId, counter: $counter) {
          res msg referenceId counter __typename
        }
      }`,
      variables: { numinst: this._numinst, referenceId, counter },
    });
    return data?.xSRequestImagesStatus ?? null;
  }

  // Récupérer la miniature / dernière image d'un device
  async getThumbnail(deviceCode) {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'xSGetThumbnail',
      query: `query xSGetThumbnail($numinst: String!, $device: String!) {
        xSGetThumbnail(numinst: $numinst, device: $device) {
          res msg img __typename
        }
      }`,
      variables: { numinst: this._numinst, device: String(deviceCode) },
    });
    return data?.xSGetThumbnail ?? null;
  }

  // ── Capture complète d'image (flux complet request → poll → thumbnail) ──

  /**
   * Flux complet : déclenche la capture, poll le statut, retourne thumbnail.
   * @param {number|number[]} deviceCode — code(s) du device XR (ex: 10 pour XR_10)
   * @returns {{ referenceId, img, res, msg }} ou lance une erreur
   */
  async captureImage(deviceCode) {
    await this._ensureNuminst();
    const devices = Array.isArray(deviceCode) ? deviceCode : [deviceCode];

    // Étape 1 : déclencher la capture
    this.homey.log(`[VerisureClient] captureImage — devices: ${JSON.stringify(devices)}`);
    const req = await this.requestImages(devices);
    if (!req) throw new Error('xSRequestImages — pas de réponse');
    if (req.res !== 'OK') throw new Error(`xSRequestImages échoué: ${req.msg}`);

    const referenceId = req.referenceId;
    this.homey.log(`[VerisureClient] captureImage — referenceId: ${referenceId}`);

    // Étape 2 : poll statut (max 20 tentatives × 3s = 60s)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await this.getRequestImagesStatus(referenceId, i + 1);
      this.homey.log(`[VerisureClient] captureImage — poll ${i+1}: res=${status?.res} msg=${status?.msg}`);
      if (status?.res === 'OK') break;
      if (status?.res === 'ERROR') throw new Error(`Capture échouée: ${status.msg}`);
    }

    // Étape 3 : récupérer la miniature
    const thumb = await this.getThumbnail(devices[0]);
    if (!thumb) throw new Error('xSGetThumbnail — pas de réponse');
    this.homey.log(`[VerisureClient] captureImage — thumbnail: res=${thumb.res} img=${thumb.img ? thumb.img.slice(0,30)+'...' : 'null'}`);

    return { referenceId, img: thumb.img, res: thumb.res, msg: thumb.msg };
  }

  // ── Services disponibles ────────────────────────────────────────────────

  async getMyServices() {
    const data = await this._gql({
      operationName: 'MyServices',
      query: `query MyServices($country: String!, $lang: String!, $panel: String!) {
        xSMyServices(country: $country, lang: $lang, panel: $panel) {
          services { id title __typename }
          __typename
        }
      }`,
      variables: { country: 'FR', lang: 'fr', panel: this._panel || 'SDVFAST' },
    });
    return data?.xSMyServices?.services ?? [];
  }

  // ── Incidents ouverts (notifications smart) ──────────────────────────────

  async getOpenIncidences() {
    await this._ensureNuminst();
    const data = await this._gql({
      operationName: 'xSSmartNotificationsOpenIncidenceList',
      query: `query xSSmartNotificationsOpenIncidenceList($numinst: String!) {
        xSSmartNotificationsOpenIncidenceList(numinst: $numinst) {
          incidences { date incidenceNumber customerName __typename }
          __typename
        }
      }`,
      variables: { numinst: this._numinst },
    });
    return data?.xSSmartNotificationsOpenIncidenceList?.incidences ?? [];
  }

  async getArmState() {
    // S'assurer que numinst est résolu AVANT de construire les variables
    await this._ensureNuminst();
    const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
    const panel   = this._panel   || this.homey.settings.get('verisure_panel') || '';
    this.homey.log('[VerisureClient] getArmState — numinst=' + (numinst || 'VIDE') + ' panel=' + (panel || 'VIDE'));

    // Essayer d'abord xSStatus (accessible aux comptes secondaires)
    try {
      const statusData = await this._gql({
        operationName: 'Status',
        query: `query Status($numinst: String!) {
          xSStatus(numinst: $numinst) {
            status timestampUpdate wifiConnected powerStatus keepAliveDay
            exceptions { status deviceType alias __typename }
            __typename
          }
        }`,
        variables: { numinst },
      });
      const raw = statusData?.xSStatus?.status;
      this.homey.log('[VerisureClient] xSStatus réponse brute:', JSON.stringify(statusData?.xSStatus));
      this.homey.log('[VerisureClient] xSStatus.status:', raw, '| numinst utilisé:', numinst || '(vide!)');
      if (raw !== null && raw !== undefined) {
        const statusMap = {
          '0': 'DISARMED', '1': 'DISARMED',
          '2': 'ARMED_AWAY', '3': 'ARMED_HOME', '4': 'ARMED_NIGHT',
          'D': 'DISARMED', 'T': 'ARMED_AWAY', 'P': 'ARMED_HOME', 'N': 'ARMED_NIGHT',
          'E': 'ARMED_DAY',
          'DISARMED': 'DISARMED', 'ARMED_AWAY': 'ARMED_AWAY', 'ARMED_HOME': 'ARMED_HOME',
        };
        const statusType = statusMap[String(raw)] || String(raw);
        const xs = statusData.xSStatus;
        return {
          statusType,
          date:          xs.timestampUpdate,
          wifiConnected: xs.wifiConnected,
          powerStatus:   xs.powerStatus,   // 'P'=secteur, 'B'=batterie
          keepAliveDay:  xs.keepAliveDay,
          exceptions:    xs.exceptions,
          changedVia:    'polling',
        };
      }
    } catch(e) {
      this.homey.log('[VerisureClient] xSStatus fallback échoué:', e.message);
    }

    // Fallback : xSCheckAlarm → referenceId (nécessite droits admin)
    const step1 = await this._gql({
      operationName: 'CheckAlarm',
      query: `query CheckAlarm($numinst: String!, $panel: String!) {
        xSCheckAlarm(numinst: $numinst, panel: $panel) {
          res msg referenceId __typename
        }
      }`,
      variables: { numinst, panel },
    });

    // null = accessPermissions insuffisantes
    if (!step1) return null;
    const referenceId = step1?.xSCheckAlarm?.referenceId;
    if (!referenceId) {
      this.homey.log('[VerisureClient] xSCheckAlarm — pas de referenceId:', JSON.stringify(step1));
      return null;
    }

    // Étape 2 : xSCheckAlarmStatus → status (avec polling jusqu'à res OK)
    const idService = '11';
    let status = null;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, pollDelay));
      const step2 = await this._gql({
        operationName: 'CheckAlarmStatus',
        query: `query CheckAlarmStatus($numinst: String!, $idService: String!, $panel: String!, $referenceId: String!) {
          xSCheckAlarmStatus(numinst: $numinst, idService: $idService, panel: $panel, referenceId: $referenceId) {
            res msg status numinst protomResponse protomResponseDate forcedArmed __typename
          }
        }`,
        variables: { numinst, idService, panel, referenceId },
      });
      const r2 = step2?.xSCheckAlarmStatus;
      this.homey.log(`[VerisureClient] CheckAlarmStatus tentative ${i+1}: res=${r2?.res} status=${r2?.status}`);
      if (r2?.res === 'OK' && (r2?.protomResponse || r2?.status)) {
        status = r2;  // garder l'objet complet
        break;
      }
      if (r2?.res === 'ERROR') break;
    }

    if (!status) return null;
    const r2 = status;  // status contient l'objet complet

    // protomResponse : 'D'=Désarmée, 'T'=Armée Total, 'P'=Armée Partielle, 'N'=Armée Nuit
    // status peut aussi être présent dans certains cas
    const protom = r2.protomResponse;
    const raw    = r2.status;
    const protomMap = {
      'D': 'DISARMED',
      'T': 'ARMED_AWAY',
      'P': 'ARMED_HOME',
      'N': 'ARMED_NIGHT',
      'E': 'ARMED_DAY',
    };
    const statusMap = {
      '0': 'DISARMED', '1': 'DISARMED',
      '2': 'ARMED_AWAY', '3': 'ARMED_HOME', '4': 'ARMED_NIGHT',
      'DISARMED': 'DISARMED', 'ARMED_AWAY': 'ARMED_AWAY', 'ARMED_HOME': 'ARMED_HOME',
    };
    const statusType = protomMap[protom] || statusMap[raw] || raw || 'DISARMED';
    return {
      statusType,
      date:       r2.protomResponseDate || new Date().toISOString(),
      changedVia: 'polling',
      protomResponse: protom,
    };
  }

  async getFullSnapshot() {
    const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
    const panel   = this._panel   || this.homey.settings.get('verisure_panel') || '';

    // Récupérer tous les devices + état alarme en parallèle
    const [armState, allDevices] = await Promise.all([
      this.getArmState().catch(() => null),
      this.getAllDevices().catch(() => []),
    ]);

    const doorWindows   = allDevices.filter(d => d.type === 'MG')
      .map(d => ({ deviceLabel: 'MG_' + d.code, area: d.name || d.code, state: 'CLOSE', type: d.type, code: d.code, serialNumber: d.serialNumber || null, reportTime: new Date().toISOString() }));
    const motionSensors = allDevices.filter(d => d.type === 'XR')
      .map(d => ({ deviceLabel: 'XR_' + d.code, area: d.name || d.code, type: d.type, code: d.code, serialNumber: d.serialNumber || null }));



    const snapshot = {
      doorWindows,
      armState,
      motionSensors,
    };
    // Sauvegarder les settings UI pour index.html
    try {
      await this.homey.settings.set('verisure_last_poll_ts',  String(Date.now()));
      await this.homey.settings.set('verisure_sensor_count',  snapshot.doorWindows.length + snapshot.motionSensors.length);
      this.homey.log('[VerisureClient] snapshot: ' + snapshot.doorWindows.length + ' MG, ' + snapshot.motionSensors.length + ' XR PIR, alarme: ' + (snapshot.armState?.statusType || '?'));
      if (snapshot.armState?.statusType) {
        await this.homey.settings.set('verisure_last_arm_state', snapshot.armState.statusType);
      }
    } catch(e) {}
    return snapshot;
  }

  // Demander une capture d'image depuis un PIR caméra (type XR)
  // code = code numérique du device (ex: 9, 10, 11, 12)
  async requestImage(deviceCode) {
    await this._ensureNuminst();
    const numinst = this._numinst;
    const panel   = this._panel || '';

    // Étape 1 : demander la capture
    const res1 = await this._gql({
      operationName: 'RequestImages',
      query: `mutation RequestImages($numinst:String!, $panel:String!, $devices:[Int]!, $mediaType:Int, $resolution:Int, $deviceType:Int) {
        xSRequestImages(numinst:$numinst, panel:$panel, devices:$devices, mediaType:$mediaType, resolution:$resolution, deviceType:$deviceType) {
          res msg referenceId __typename
        }
      }`,
      variables: { numinst, panel, devices: [parseInt(deviceCode)], mediaType: 1, resolution: 1, deviceType: 1 },
    });
    const ref = res1?.xSRequestImages?.referenceId;
    if (!ref) throw new Error(`Capture refusée : ${res1?.xSRequestImages?.msg || 'Erreur'}`);
    this.homey.log(`[VerisureClient] xSRequestImages demandé, referenceId: ${ref}`);

    // Étape 2 : polling jusqu'à disponibilité
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res2 = await this._gql({
        operationName: 'RequestImagesStatus',
        query: `query RequestImagesStatus($numinst:String!, $panel:String!, $devices:[Int!]!, $referenceId:String!, $counter:Int) {
          xSRequestImagesStatus(numinst:$numinst, panel:$panel, devices:$devices, referenceId:$referenceId, counter:$counter) {
            res msg numinst status __typename
          }
        }`,
        variables: { numinst, panel, devices: [parseInt(deviceCode)], referenceId: ref, counter: i + 1 },
      });
      const status = res2?.xSRequestImagesStatus?.status;
      this.homey.log(`[VerisureClient] xSRequestImagesStatus[${i}]: ${status}`);
      if (status === 'DONE' || status === 'OK') {
        return { referenceId: ref, status };
      }
    }
    throw new Error('Timeout attente image caméra');
  }

  // Récupérer la dernière miniature d'un PIR caméra
  async getThumbnail(deviceCode, zoneId) {
    await this._ensureNuminst();
    const numinst = this._numinst;
    const panel   = this._panel || '';
    const data = await this._gql({
      operationName: 'mkGetThumbnail',
      query: `query mkGetThumbnail($numinst:String!, $panel:String!, $device:String, $zoneId:String, $idSignal:String) {
        xSGetThumbnail(numinst:$numinst, device:$device, panel:$panel, zoneId:$zoneId, idSignal:$idSignal) {
          idSignal deviceId deviceCode deviceAlias timestamp signalType image type quality __typename
        }
      }`,
      variables: { numinst, panel, device: String(deviceCode), zoneId: zoneId || null },
    });
    return data?.xSGetThumbnail || null;
  }

  async getSmartCams() {
    const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
    const email   = this._email   || this.homey.settings.get('verisure_email') || '';
    const data = await this._gql({
      operationName: 'mkGetAllCameras',
      query: `query mkGetAllCameras($numinst: String!, $user: String!, $lang: String!, $userCameraTypes: [String]) {
        xSGetAllCameras(numinst: $numinst, user: $user, lang: $lang, userCameraTypes: $userCameraTypes) {
          res msg
          cameras { brand model alias serial __typename }
          pir { alias code deviceId type __typename }
          arlo { catalog { brand serial alias model online latestThumbnailUri __typename } __typename }
          vc4 { serial alias deviceId type __typename }
          __typename
        }
      }`,
      variables: { numinst, user: email, lang: 'fr', userCameraTypes: ['PIR Camera'] },
    });
    const result = data?.xSGetAllCameras;
    if (!result) return [];
    // Normaliser vers le format attendu par les devices
    const cameras = [
      ...(result.cameras || []).map(c => ({ deviceLabel: c.serial || c.alias, area: c.alias, online: true, imageCaptureAllowed: true, type: 'camera' })),
      ...(result.pir     || []).map(p => ({ deviceLabel: p.deviceId || p.code, area: p.alias, online: true, imageCaptureAllowed: false, type: 'pir' })),
      ...(result.vc4     || []).map(v => ({ deviceLabel: v.deviceId || v.serial, area: v.alias, online: true, imageCaptureAllowed: true, type: 'vc4' })),
      ...((result.arlo?.catalog) || []).map(a => ({ deviceLabel: a.serial, area: a.alias, online: a.online, imageCaptureAllowed: true, latestThumbnailUri: a.latestThumbnailUri, type: 'arlo' })),
    ];
    return cameras;
  }

  async getCameraRequestId(deviceLabel) {
    const data = await this._gql({ operationName: 'CameraRequestId', query: `query CameraRequestId($giid: String!, $deviceLabel: String!) { installation(giid: $giid) { cameraRequestId(deviceLabel: $deviceLabel) __typename } }`, variables: { giid: this._giid, deviceLabel } });
    const id = data?.installation?.cameraRequestId;
    if (!id) throw new Error(`Impossible d'obtenir un requestId pour ${deviceLabel}`);
    return id;
  }

  async captureImage(deviceLabel, requestId) {
    const data = await this._gql({ operationName: 'CameraCapture', query: `mutation CameraCapture($giid: String!, $deviceLabel: String!, $requestId: String!) { installation(giid: $giid) { cameraCapture(deviceLabel: $deviceLabel, requestId: $requestId) __typename } }`, variables: { giid: this._giid, deviceLabel, requestId } });
    return !!data?.installation?.cameraCapture;
  }

  async getLastCameraImage(deviceLabel) {
    const data = await this._gql({ operationName: 'CameraLastImage', query: `query CameraLastImage($giid: String!, $deviceLabel: String!) { installation(giid: $giid) { cameraLastImage(deviceLabel: $deviceLabel) { deviceLabel captureTime contentType imageUrl __typename } __typename } }`, variables: { giid: this._giid, deviceLabel } });
    return data?.installation?.cameraLastImage ?? null;
  }

  async downloadImage(imageUrl) {
    const res = await this._fetchWithJar(imageUrl, { agent: this._agent, headers: this._fullHeaders() });
    if (!res.ok) throw new Error(`Téléchargement image échoué : ${res.status}`);
    return res.buffer();
  }

  async captureAndFetch(deviceLabel, waitMs = 4000) {
    const requestId = await this.getCameraRequestId(deviceLabel);
    await this.captureImage(deviceLabel, requestId);
    await new Promise(r => setTimeout(r, waitMs));
    return this.getLastCameraImage(deviceLabel);
  }


  // ── ARM / DARM ──────────────────────────────────────────────────────────────

  /**
   * Arme ou désarme l'alarme.
   * @param {'ARMED_AWAY'|'ARMED_HOME'|'ARMED_NIGHT'|'ARMED_DAY'|'DISARMED'} targetState
   * @param {string} code  Code PIN Verisure (optionnel)
   * @returns {Promise<{statusType:string, protomResponse:string}>}
   */
  async setArmState(targetState, code) {
    // code est optionnel — certaines installations n'en nécessitent pas
    const pin = code || null;

    const numinst = this._numinst;
    const panel   = this._panel || '';
    const idService = '11'; // service EST

    if (targetState === 'DISARMED') {
      return this._disarm(pin, numinst, panel, idService);
    } else {
      return this._arm(targetState, pin, numinst, panel, idService);
    }
  }

  async _arm(targetState, code, numinst, panel, idService) {
    // ArmCodeRequest est un enum string GraphQL — valeurs observées dans le trafic réseau :
    // ARM1=total, ARMDAY1=jour, ARMNIGHT1=nuit, PERI1=extérieur
    // Mapping exact vers l'enum ArmCodeRequest GraphQL
    // observé dans le trafic réseau Verisure France
    // 4 modes supportés sur SDVFAST France :
    // Désactivée=DARM1, Partiel Jour=ARMDAY1, Partiel Nuit=ARMNIGHT1, Total=ARM1
    const armRequestMap = {
      'ARMED_AWAY':  'ARM1',       // Mode Total
      'ARMED_DAY':   'ARMDAY1',    // Partiel Jour
      'ARMED_NIGHT': 'ARMNIGHT1',  // Partiel Nuit
      'ARMED_HOME':  'ARMDAY1',    // Fallback → Partiel Jour
    };
    const armRequest = armRequestMap[targetState] || 'ARM1';

    const res1 = await this._gql({
      operationName: 'xSArmPanel',
      query: `mutation xSArmPanel($numinst: String!, $request: ArmCodeRequest!, $panel: String!) {
        xSArmPanel(numinst: $numinst, request: $request, panel: $panel) {
          res msg referenceId pollingTime __typename
        }
      }`,
      variables: { numinst, panel, request: armRequest },
    });
    const r1 = res1?.xSArmPanel;
    const ref = r1?.referenceId;
    if (!ref) throw new Error(`Armement refusé : ${r1?.msg || 'Erreur inconnue'}`);
    const pollDelay = r1?.pollingTime ? parseInt(r1.pollingTime) * 1000 : 2000;
    this.homey.log(`[VerisureClient] xSArmPanel demandé request=${armRequest} numinst=${numinst} panel=${panel} — referenceId:${ref} pollingTime:${r1?.pollingTime}s`);

    return this._pollArmStatus('xSArmStatus', numinst, panel, idService, ref, targetState,
      { request: armRequest, armAndLock: false, pollDelay });
  }

  // Désarmement rapide sans polling — pour les transitions armé→armé
  // Envoie DARM1 et retourne immédiatement sans attendre xSArmStatus
  async _disarmQuick(numinst, panel) {
    await this._ensureNuminst();
    try {
      await this._gql({
        operationName: 'xSDisarmPanel',
        query: `mutation xSDisarmPanel($numinst: String!, $request: DisarmCodeRequest!, $panel: String!) {
          xSDisarmPanel(numinst: $numinst, request: $request, panel: $panel) {
            res msg referenceId __typename
          }
        }`,
        variables: { numinst, panel, request: 'DARM1' },
      });
      this.homey.log('[VerisureClient] _disarmQuick — DARM1 envoyé');
    } catch(e) {
      this.homey.log('[VerisureClient] _disarmQuick erreur (non bloquant):', e.message);
    }
  }

  async _disarm(code, numinst, panel, idService) {
    // DisarmCodeRequest est un enum string GraphQL — valeur observée : "DARM1"
    // Le code PIN n'est pas utilisé dans le payload observé sur l'API France
    const requestValue = 'DARM1';

    const res1 = await this._gql({
      operationName: 'xSDisarmPanel',
      query: `mutation xSDisarmPanel($numinst: String!, $request: DisarmCodeRequest!, $panel: String!) {
        xSDisarmPanel(numinst: $numinst, request: $request, panel: $panel) {
          res msg referenceId pollingTime __typename
        }
      }`,
      variables: { numinst, panel, request: requestValue },
    });
    const r1  = res1?.xSDisarmPanel;
    const ref = r1?.referenceId;
    if (!ref) throw new Error(`Désarmement refusé : ${r1?.msg || 'Erreur inconnue'}`);
    // pollingTime est en secondes — convertir en ms
    const pollDelay = r1?.pollingTime ? parseInt(r1.pollingTime) * 1000 : 2000;
    this.homey.log(`[VerisureClient] xSDisarmPanel — referenceId:${ref} pollingTime:${r1?.pollingTime}s`);

    // Le désarmement utilise xSArmStatus (même query que l'armement)
    return this._pollArmStatus('xSArmStatus', numinst, panel, idService, ref, 'DISARMED',
      { pollDelay });
  }

  async _pollArmStatus(fieldName, numinst, panel, idService, referenceId, expectedState,
                        { request, forceArmingRemoteId, armAndLock, pollDelay = 2000 } = {}) {
    // Query ArmStatus exacte observée dans le trafic réseau Verisure
    const ARM_STATUS_QUERY = `query ArmStatus(
      $numinst: String!, $request: ArmCodeRequest, $panel: String!,
      $referenceId: String!, $counter: Int!,
      $forceArmingRemoteId: String, $armAndLock: Boolean
    ) {
      xSArmStatus(
        numinst: $numinst panel: $panel referenceId: $referenceId
        counter: $counter request: $request
        forceArmingRemoteId: $forceArmingRemoteId armAndLock: $armAndLock
      ) {
        res msg status protomResponse protomResponseDate numinst requestId
        error { code type allowForcing exceptionsNumber referenceId suid __typename }
        smartlockStatus { state deviceId updatedOnArm __typename }
        __typename
      }
    }`;

    // Query CheckAlarmStatus pour le fallback disarm / check
    const CHECK_STATUS_QUERY = `query CheckAlarmStatus(
      $numinst: String!, $idService: String!, $panel: String!, $referenceId: String!
    ) {
      xSCheckAlarmStatus(numinst: $numinst idService: $idService panel: $panel referenceId: $referenceId) {
        res msg status numinst protomResponse protomResponseDate forcedArmed __typename
      }
    }`;

    // Routing : ARM → ArmStatus/xSArmStatus, DARM → ArmStatus/xSArmStatus aussi
    // (xSDisarmStatus utilise la même query ArmStatus observée dans le trafic)
    const useArmQuery  = (fieldName === 'xSArmStatus' || fieldName === 'xSDisarmStatus');
    const query        = useArmQuery ? ARM_STATUS_QUERY : CHECK_STATUS_QUERY;
    const opName       = useArmQuery ? 'ArmStatus' : 'CheckAlarmStatus';
    const resultKey    = useArmQuery ? 'xSArmStatus' : 'xSCheckAlarmStatus';

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, pollDelay));

      // Ne pas renvoyer request dans le polling ArmStatus — peut causer TECHNICAL_ERROR
      const variables = useArmQuery
        ? { numinst, panel, referenceId, counter: i + 1,
            request: null,
            forceArmingRemoteId: forceArmingRemoteId || null,
            armAndLock: armAndLock || false }
        : { numinst, idService, panel, referenceId };

      const res = await this._gql({ operationName: opName, query, variables });
      const data = res?.[resultKey];
      if (!data) continue;

      if (data.error) {
        const err = data.error;
        this.homey.log(`[VerisureClient] ArmStatus erreur brute:`, JSON.stringify(err));
        // allowForcing=true → porte ouverte mais on peut forcer
        if (err.allowForcing) {
          this.homey.log(`[VerisureClient] ArmStatus — exception (${err.exceptionsNumber} device(s)), forçage possible`);
          throw Object.assign(new Error(`Armement bloqué : ${err.exceptionsNumber} capteur(s) ouvert(s)`),
            { code: err.code, allowForcing: true, referenceId: err.referenceId });
        }
        // TECHNICAL_ERROR → mode non supporté par cette centrale
        if (err.type === 'TECHNICAL_ERROR' && err.code && err.code.includes('alarm-manager')) {
          throw new Error(`Mode d'armement non supporté par cette centrale. Vérifiez les modes disponibles.`);
        }
        throw new Error(`Erreur arm/disarm [${err.code}]: ${err.type}`);
      }

      if (data.res === 'OK') {
        const protom = data.protomResponse || data.status;
        const statusType = this._protomToStatusType(protom) || expectedState;
        this.homey.log(`[VerisureClient] ${resultKey} OK — protom:${protom} → ${statusType}`);
        return { statusType, protomResponse: protom, forcedArmed: data.forcedArmed };
      }

      this.homey.log(`[VerisureClient] ${resultKey} tentative ${i+1}/15 — res:${data.res} status:${data.status}`);
    }
    throw new Error('Timeout arm/disarm — état inconnu après 30 secondes');
  }

  _protomToStatusType(protom) {
    const map = { D: 'DISARMED', T: 'ARMED_AWAY', P: 'ARMED_HOME', N: 'ARMED_NIGHT', D2: 'ARMED_DAY', E: 'ARMED_DAY' };
    return map[protom] || null;
  }

  // ── EVENT LOG (capteurs de contact en temps réel) ─────────────────────────

  /**
   * Récupère le journal d'événements Verisure.
   * @param {number} pageSize   Nombre d'événements (défaut 30)
   * @param {string[]} categories  Ex: ['ARM','DISARM','DOOR_WINDOW','LOCK','UNLOCK']
   * @returns {Promise<Array>}
   */
  async getEventLog(pageSize = 30, categories = ['DOOR_WINDOW', 'ARM', 'DISARM']) {
    await this._ensureNuminst();
    const numinst = this._numinst || this.homey.settings.get('verisure_numinst');
    if (!numinst) { this.homey.log('[VerisureClient] getEventLog — numinst absent, abandon'); return []; }

    // L'API France utilise xSEntry (pas xSEntry)
    // On tente plusieurs signatures pour découvrir laquelle est acceptée
    const attempts = [
      // Tentative 1 : xSEntry sans eventCategories ni offset
      { name:'xSEntry-minimal', query:`query Entry($numinst:String!,$pageSize:Int!){xSEntry(numinst:$numinst,pageSize:$pageSize){moreDataAvailable pagedList{device{deviceLabel area __typename}eventCategory eventType ts additionalInfo armStateValue __typename}__typename}}`, vars:{ numinst, pageSize }, key:'xSEntry' },
      // Tentative 2 : xSEntry avec eventCategories
      { name:'xSEntry-cats', query:`query Entry($numinst:String!,$pageSize:Int!,$eventCategories:[String]){xSEntry(numinst:$numinst,pageSize:$pageSize,eventCategories:$eventCategories){moreDataAvailable pagedList{device{deviceLabel area __typename}eventCategory eventType ts additionalInfo armStateValue __typename}__typename}}`, vars:{ numinst, pageSize, eventCategories: categories }, key:'xSEntry' },
      // Tentative 3 : xSEntry avec offset
      { name:'xSEntry-offset', query:`query Entry($numinst:String!,$pageSize:Int!,$offset:Int!){xSEntry(numinst:$numinst,pageSize:$pageSize,offset:$offset){moreDataAvailable pagedList{device{deviceLabel area __typename}eventCategory eventType ts additionalInfo armStateValue __typename}__typename}}`, vars:{ numinst, pageSize, offset:0 }, key:'xSEntry' },
    ];

    for (const attempt of attempts) {
      try {
        const data = await this._gql({ operationName:'Entry', query: attempt.query, variables: attempt.vars });
        this.homey.log('[VerisureClient] ' + attempt.name + ' réponse:', JSON.stringify(data).slice(0, 300));
        const list = data?.[attempt.key]?.pagedList ?? [];
        this.homey.log('[VerisureClient] ' + attempt.name + ' — ' + list.length + ' événements');
        if (list.length) this.homey.log('[VerisureClient] EventLog[0]:', JSON.stringify(list[0]).slice(0, 300));
        return list; // succès → on s'arrête
      } catch(e) {
        this.homey.log('[VerisureClient] ' + attempt.name + ' échec:', e.message);
      }
    }
    return [];
  }

  /**
   * Détecte les ouvertures/fermetures récentes des capteurs via xSEntry.
   * Retourne un tableau { deviceLabel, area, state:'OPEN'|'CLOSE', ts } pour
   * les événements survenus depuis lastTs (timestamp ms).
   * @param {number} lastTs  Timestamp ms de la dernière vérification
   */
  async getDoorWindowEventsFrom(lastTs) {
    const events = await this.getEventLog(50, ['DOOR_WINDOW']);
    const results = [];
    for (const ev of events) {
      const evTs = new Date(ev.ts).getTime();
      if (evTs <= lastTs) continue; // déjà connu
      const label = ev.device?.deviceLabel;
      const area  = ev.device?.area || ev.gatewayArea || '';
      if (!label) continue;
      // eventType contient 'DOORWINDOW_STATE_CHANGED', additionalInfo 'OPEN'/'CLOSE'
      const stateRaw = (ev.additionalInfo || '').toUpperCase();
      const state = stateRaw === 'OPEN' ? 'OPEN' : stateRaw === 'CLOSE' ? 'CLOSE' : null;
      if (state) results.push({ deviceLabel: label, area, state, ts: evTs, alarmContact: state === 'OPEN' });
    }
    return results;
  }

    static toAlarmContact(state) { return state === 'OPEN'; }
  static toHomeyAlarmState(s) {
    switch (s) {
      case 'ARMED_AWAY':  return 'armed';
      case 'ARMED_HOME':  return 'partially_armed';
      case 'ARMED_NIGHT': return 'partially_armed';
      case 'ARMED_DAY':   return 'partially_armed';
      default:            return 'disarmed';
    }
  }

  // 4 états Verisure → capability custom verisure_alarm_state
  static toVerisureAlarmState(s) {
    switch (s) {
      case 'ARMED_AWAY':  return 'armed_away';
      case 'ARMED_HOME':  return 'armed_day';   // P = partiel = jour sur alarme France
      case 'ARMED_DAY':   return 'armed_day';
      case 'ARMED_NIGHT': return 'armed_night';
      default:            return 'disarmed';
    }
  }
}

module.exports = VerisureClient;
