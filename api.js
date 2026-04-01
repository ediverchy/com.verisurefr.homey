'use strict';

// Guard : vérifie que homey.app est disponible avant chaque appel
function requireApp(homey) {
  if (!homey) {
    throw new Error('homey est undefined dans api.js');
  }
  if (!homey.app) {
    // Tenter d'accéder à l'app via le module Homey directement
    try {
      const Homey = require('homey');
      if (Homey.app) return Homey.app;
    } catch(_) {}
    const keys = Object.keys(homey).join(', ');
    throw new Error('homey.app est undefined. Clés disponibles: ' + keys);
  }
  return homey.app;
}

module.exports = {

  async sessionLogin({ homey, body }) {
    const { email, password } = body;
    if (!email || !password) throw new Error('Email et mot de passe requis.');
    try {
      const phones = await requireApp(homey).sessionLogin(email, password);
      // Persister l'email pour affichage
      await homey.settings.set('verisure_email', email);
      return { ok: true, phones };
    } catch (err) {
      throw new Error(err.message || 'Erreur inconnue lors de la connexion.');
    }
  },

  async sessionRequestOtp({ homey, body }) {
    const { phoneIndex } = body;
    if (phoneIndex === undefined || phoneIndex === null) throw new Error('phoneIndex requis.');
    try {
      await requireApp(homey).sessionRequestOtp(phoneIndex);
      return { ok: true };
    } catch (err) {
      throw new Error(err.message || 'Erreur lors de l\'envoi du SMS.');
    }
  },

  async sessionMfa({ homey, body }) {
    const { code } = body;
    if (!code) throw new Error('Code requis.');
    try {
      await requireApp(homey).sessionMfa(code);
      return { ok: true };
    } catch (err) {
      throw new Error(err.message || 'Code OTP invalide.');
    }
  },

  async sessionClear({ homey }) {
    try {
      await requireApp(homey).sessionClear();
    } catch (_) {}

    return { ok: true };
  },

  // Endpoint diagnostic — retourne la réponse brute de l'API Verisure
  async sessionDebug({ homey, body }) {
    const { email, password, bearerToken } = body;
    if (!email || !password) throw new Error('Email et mot de passe requis.');
    const result = await requireApp(homey).sessionDebug(email, password, bearerToken || null);
    return result;
  },

  async testJwt({ homey, body }) {
    const { email, jwtHash } = body;
    if (!email || !jwtHash) throw new Error('email et jwtHash requis');
    return await requireApp(homey).testJwt(email, jwtHash);
  },

  async verifyOtp({ homey, body }) {
    const { email, otp } = body;
    if (!email || !otp) throw new Error('email et otp requis');
    return await requireApp(homey).verifyOtpForTest(email, otp);
  },

  async sendOtp({ homey, body }) {
    const { email, recordId } = body;
    if (!email || recordId === undefined) throw new Error('email et recordId requis');
    return await requireApp(homey).sendOtpForTest(email, recordId);
  },

  // Endpoint logs — retourne les derniers logs de l'app
  async getLogs({ homey }) {
    return { logs: requireApp(homey).getLogs() };
  },

  // Endpoint init-giid — appelle _initGiid et retourne le résultat brut
  async initGiid({ homey }) {
    return await requireApp(homey).initGiid();
  },

  // Endpoint test-act-v2 — journal d'activité via GraphQL ActV2Timeline
  async testActV2({ homey, query }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif — reconnectez-vous.' };
    try {
      const numRows = parseInt(query?.numRows || '30');
      homey.log('[ACT_V2] Appel ActV2Timeline GraphQL (numRows=' + numRows + ')...');
      const reg = await client.getActV2({ numRows });
      homey.log('[ACT_V2] ' + reg.length + ' entrées reçues');
      return { ok: true, count: reg.length, reg };
    } catch(e) {
      homey.log('[ACT_V2] Erreur:', e.message);
      return { error: e.message };
    }
  },

  // Endpoint request-image — déclenche une capture sur un PIR caméra
  async requestImage({ homey, body }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };

    const deviceCode = parseInt(body?.device ?? body?.deviceCode ?? 10);
    if (isNaN(deviceCode)) return { error: 'device (code PIR) requis.' };

    try {
      homey.log('[requestImage] Demande image device code:', deviceCode);

      // Étape 1 — déclencher la capture
      const req = await client.requestImages([deviceCode]);
      homey.log('[requestImage] Réponse:', JSON.stringify(req));

      if (!req || req.res !== 'OK') {
        return { error: req?.msg || 'Demande refusée', raw: req };
      }

      const referenceId = req.referenceId;
      homey.log('[requestImage] referenceId:', referenceId);

      // Étape 2 — attendre confirmation (max 10 tentatives × 3s)
      let status = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        status = await client.getRequestImagesStatus(referenceId);
        homey.log('[requestImage] Status poll', i + 1, ':', JSON.stringify(status));
        if (status?.res === 'OK') break;
      }

      return {
        ok: true,
        referenceId,
        requestResult: req,
        statusResult:  status,
      };
    } catch(e) {
      return { error: e.message };
    }
  },

  // Endpoint request-image — demande image + polling + thumbnail
  async requestImage({ homey, body }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };

    const deviceCode = parseInt(body?.device ?? 10);
    homey.log('[requestImage] device code:', deviceCode);

    try {
      // Étape 1 : demande d'images
      const req = await client.requestImages([deviceCode]);
      homey.log('[requestImage] xSRequestImages:', JSON.stringify(req));
      if (!req || req.res !== 'OK') {
        return { error: 'Demande refusée : ' + (req?.msg || 'réponse invalide'), raw: req };
      }

      const referenceId = req.referenceId;
      if (!referenceId) return { error: 'Pas de referenceId dans la réponse', raw: req };

      // Étape 2 : polling statut (max 10 tentatives, 2s entre chaque)
      let statusResult = null;
      for (let counter = 1; counter <= 10; counter++) {
        await new Promise(r => setTimeout(r, 2000));
        statusResult = await client.getRequestImagesStatus(referenceId, counter);
        homey.log('[requestImage] status counter=' + counter + ':', JSON.stringify(statusResult));
        if (statusResult?.res === 'OK') break;
      }

      // Étape 3 : thumbnail
      const thumb = await client.getThumbnail(deviceCode).catch(() => null);
      homey.log('[requestImage] thumbnail:', thumb?.res, 'img length:', thumb?.img?.length ?? 0);

      return {
        ok:          true,
        referenceId,
        status:      statusResult,
        thumbnail:   thumb ? { res: thumb.res, msg: thumb.msg, imgLength: thumb.img?.length ?? 0 } : null,
        // img base64 tronquée pour le log
        imgPreview:  thumb?.img ? thumb.img.slice(0, 100) + '...' : null,
      };
    } catch(e) {
      return { error: e.message };
    }
  },

  // Endpoint request-image — déclenche une demande d'image PIR et poll le statut
  async requestImage({ homey, body }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };

    const { deviceCode } = body || {};
    if (!deviceCode && deviceCode !== 0) return { error: 'deviceCode requis (ex: 9, 10, 11, 12)' };

    try {
      // Étape 1 : déclencher la capture
      homey.log(`[requestImage] Demande image device code=${deviceCode}`);
      const r1 = await client.requestImages([parseInt(deviceCode)]);
      homey.log('[requestImage] xSRequestImages:', JSON.stringify(r1));

      if (!r1 || r1.res === 'ERR') {
        return { error: r1?.msg || 'Erreur xSRequestImages', raw: r1 };
      }

      const referenceId = r1.referenceId;
      if (!referenceId) return { error: 'Pas de referenceId', raw: r1 };

      homey.log(`[requestImage] referenceId: ${referenceId} — polling statut...`);

      // Étape 2 : poll xSRequestImagesStatus jusqu'à res=OK (max 20s)
      let statusResult = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const r2 = await client.getRequestImagesStatus(referenceId);
        homey.log(`[requestImage] status tentative ${i+1}:`, JSON.stringify(r2));
        if (r2?.res === 'OK') { statusResult = r2; break; }
      }

      return {
        ok: true,
        step1: r1,
        referenceId,
        statusResult,
        note: statusResult
          ? 'Image capturée — utilisez referenceId pour récupérer la miniature'
          : 'Timeout — image peut-être en cours de traitement',
      };

    } catch(e) {
      return { error: e.message };
    }
  },

  // Endpoint test-cameras
  async testCameras({ homey }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };
    try {
      const result = await client.getAllCameras();
      homey.log('[testCameras]', JSON.stringify(result)?.slice(0, 500));
      return { ok: true, result };
    } catch(e) { return { error: e.message }; }
  },

  // Endpoint test-keys — télécommandes et badges
  async testKeys({ homey }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };
    try {
      const keys = await client.getKeys();
      homey.log('[testKeys]', keys.length, 'clés');
      return { ok: true, count: keys.length, keys };
    } catch(e) { return { error: e.message }; }
  },

  // Endpoint test-scheduler — programmations ARM/DARM
  async testScheduler({ homey }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };
    try {
      const result = await client.getScheduler();
      homey.log('[testScheduler]', JSON.stringify(result)?.slice(0, 300));
      return { ok: true, result };
    } catch(e) { return { error: e.message }; }
  },

  // Endpoint test-incidences — incidents de télésurveillance
  async testIncidences({ homey }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };
    try {
      const incidences = await client.getIncidenceList();
      homey.log('[testIncidences]', incidences.length, 'incidents');
      return { ok: true, count: incidences.length, incidences };
    } catch(e) { return { error: e.message }; }
  },

  // Endpoint capture-image — demande d'image sur un device PIR
  async captureImage({ homey, body }) {
    const { deviceCode } = body;
    if (!deviceCode) return { error: 'deviceCode requis (ex: 10 pour XR_10)' };
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };
    try {
      homey.log(`[captureImage] Demande image device ${deviceCode}...`);
      const result = await client.captureImage(Number(deviceCode));
      homey.log('[captureImage] résultat:', JSON.stringify(result)?.slice(0, 200));
      return { ok: true, ...result };
    } catch(e) {
      return { error: e.message };
    }
  },

  // Endpoint test-services — services disponibles
  async testServices({ homey }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: 'Pas de client actif.' };
    try {
      const services = await client.getMyServices();
      homey.log('[testServices]', services.length, 'services');
      return { ok: true, count: services.length, services };
    } catch(e) { return { error: e.message }; }
  },

  // Endpoint test-devices — retourne les devices depuis xSDeviceList
  async testDevices({ homey }) {
    const client = requireApp(homey).poller?._client;
    if (!client) return { error: "Pas de client actif" };
    await client._ensureNuminst();
    const numinst = client._numinst;
    const panel   = client._panel || '';
    if (!numinst) return { error: 'numinst non résolu' };
    try {
      const data = await client._gql({
        operationName: 'xSDeviceList',
        query: `query xSDeviceList($numinst:String!, $panel:String!) {
          xSDeviceList(numinst:$numinst, panel:$panel) {
            devices { code zoneId name type __typename }
          }
        }`,
        variables: { numinst, panel }
      });
      const devices = data?.xSDeviceList?.devices ?? [];

      // Enrichir avec l'état du cache poller + devices Homey
      const app    = requireApp(homey);
      const poller = app.poller;
      const armState = homey.settings.get('verisure_last_arm_state') || '';

      // Récupérer les compteurs depuis les devices Homey couplés
      const getCount = (driverId, deviceLabel) => {
        try {
          const driver = app.driver?.[driverId]
            || Object.values(app.homey.drivers?.getDrivers?.() || {})
                     .find(d => d.id === driverId);
          if (!driver) return 0;
          const dev = driver.getDevices().find(d => d.getSetting('deviceLabel') === deviceLabel);
          return dev?.getCapabilityValue('measure_count') || 0;
        } catch(e) { return 0; }
      };

      const enrich = (d) => {
        const mgLabel  = 'MG_' + d.code;
        const xrLabel  = 'XR_' + d.code;
        const cached   = d.type === 'MG' ? poller?._lastDoorWindows?.get(mgLabel)  : undefined;
        const pirState = d.type === 'XR' ? poller?._lastMotionSensors?.get(xrLabel): undefined;
        const count    = d.type === 'MG' ? getCount('contact-sensor', mgLabel)
                       : d.type === 'XR' ? getCount('pir-camera',     xrLabel)
                       : undefined;
        return {
          ...d,
          state: d.type === 'MG'   ? (cached    !== undefined ? cached    : 'CLOSE')
               : d.type === 'XR'   ? (pirState  !== undefined ? pirState  : false)
               : d.type === 'CENT' ? armState
               : undefined,
          count,
        };
      };

      const enriched = devices.map(enrich);
      return {
        numinst, panel,
        count: enriched.length,
        devices: enriched,
        contacts: enriched.filter(d => d.type === 'MG'),
        pir:      enriched.filter(d => d.type === 'XR'),
        alarm:    enriched.filter(d => d.type === 'CENT'),
      };
    } catch(e) {
      return { error: e.message };
    }
  },

  // Endpoint test-alarm — teste getArmState directement
  async testAlarm({ homey }) {
    return await requireApp(homey).testAlarm();
  },

  // Endpoint test-status — teste xSStatus directement
  async testStatus({ homey }) {
    return await requireApp(homey).testStatus();
  },

  // Endpoint test-capabilities — tente d'obtenir le token x-capabilities
  async testCapabilities({ homey }) {
    return await requireApp(homey).testCapabilities();
  },

  // Endpoint test-entry — teste xSEntry (EventLog France)
  async testEntry({ homey }) {
    return await requireApp(homey).testEntry();
  },
};
