'use strict';

const { Driver } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * PirCameraDriver
 *
 * Driver pour le détecteur PIR avec caméra Verisure (GuardVision / SmartCam).
 *
 * Flow cards déclarées dans app.json :
 *   triggers  : motion_detected, image_captured
 *   conditions: —
 *   actions   : capture_image
 */
class PirCameraDriver extends Driver {

  async onInit() {
    this.log('[PirCameraDriver] Init');

    // Trigger : mouvement détecté (via polling état + event log)
    this._triggerMotionDetected = this.homey.flow.getDeviceTriggerCard('motion_detected');

    // Action Flow : remettre le compteur à zéro
    this.homey.flow.getActionCard('pir_reset_count')
      .registerRunListener(async ({ device }) => {
        await device.resetCount();
      });

    // Trigger : nouvelle image capturée (après action ou mouvement)
    this._triggerImageCaptured  = this.homey.flow.getDeviceTriggerCard('image_captured');

    // Action : déclencher une capture depuis un Flow
    const captureAction = this.homey.flow.getActionCard('capture_image');
    captureAction.registerRunListener(async ({ device }) => {
      return device.triggerCapture();
    });

    this.log('[PirCameraDriver] Flow cards enregistrées');
  }

  // ---------------------------------------------------------------------------
  // Helpers Flow — appelés depuis PirCameraDevice
  // ---------------------------------------------------------------------------

  async triggerMotionDetected(device, tokens) {
    await this._triggerMotionDetected.trigger(device, tokens);
  }

  async triggerImageCaptured(device, tokens) {
    await this._triggerImageCaptured.trigger(device, tokens);
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  async onPairListDevices() {
    this.log('[PirCameraDriver] Récupération caméras PIR...');

    // Utiliser le client du poller (session active avec cookies valides)
    if (!this.homey.app || !this.homey.app.poller || !this.homey.app.poller._client) {
      throw new Error('Session non disponible — connectez-vous dans les réglages d\'abord');
    }
    const client = this.homey.app.poller._client;
    this.log('[PirCameraDriver] Client poller réutilisé');

    // Utiliser getAllDevices() et filtrer type === 'XR' (PIR caméra)
    const allDevices = await client.getAllDevices();
    const cameras = allDevices
      .filter(d => d.type === 'XR')
      .map(d => ({
        deviceLabel: 'XR_' + d.code,
        area:        d.name || d.code,
        code:        d.code,
        type:        d.type,
        serialNumber: d.serialNumber || null,
        imageCaptureAllowed: true,
      }));

    if (!cameras.length) {
      throw new Error(this.homey.__('error.no_cameras_found'));
    }

    const existingLabels = new Set(
      this.getDevices().map(d => d.getSetting('deviceLabel'))
    );

    const newDevices = cameras
      .filter(c => !existingLabels.has(c.deviceLabel))
      .map(cam => ({
        name: cam.area || cam.deviceLabel,
        data: { id: cam.deviceLabel },
        settings: {
          deviceLabel:         cam.deviceLabel,
          area:                cam.area || '',
          imageCaptureAllowed: true,
        },
        capabilities: ['alarm_motion'],
      }));

    this.log(`[PirCameraDriver] ${newDevices.length} PIR XR disponible(s)`);
    return newDevices;
  }

  onPair(session) {
    let pendingClient = null;
    let pendingEmail  = null;

    // check_session — appelé par start.html au chargement
    session.setHandler('check_session', async () => {
      const hash  = this.homey.settings.get('verisure_auth_hash');
      const email = this.homey.settings.get('verisure_email');
      if (hash && email) {
        this.log(`[${cls}] Session existante pour ${email}`);
        return { sessionReused: true, email };
      }
      return { sessionReused: false };
    });

    // start.html — étape 1 : login + déclenche le SMS OTP
    session.setHandler('login_start', async ({ email, password }) => {
      this.log('[PirCameraDriver] Pairing — login_start');
      // Réutiliser session existante si déjà connecté via index.html
      const existingHash  = this.homey.settings.get('verisure_auth_hash');
      const existingEmail = this.homey.settings.get('verisure_email');
      if (existingHash && existingEmail) {
        this.log('[PirCameraDriver] Session existante — réutilisation');
        return { ok: true, sessionReused: true };
      }
      const VerisureClient = require('../../lib/VerisureClient');
      const client = new VerisureClient({ homey: this.homey, email, password });
      const phones = await client.initiateLogin(email, password);
      pendingClient = client;
      pendingEmail  = email;
      return { ok: true, phones };
    });

    // mfa.html — email pour affichage
    session.setHandler('get_email', async () => pendingEmail);

    // mfa.html — étape 2 : valide le code OTP
    session.setHandler('login_mfa', async ({ code }) => {
      this.log('[PirCameraDriver] Pairing — login_mfa');
      if (!pendingClient) throw new Error('login_start doit être appelé avant login_mfa');
      await pendingClient.confirmMfa(code);
      pendingClient = null;
      pendingEmail  = null;
      await this.homey.app.poller.restart();
      return { ok: true };
    });

    // list_devices — liste les caméras PIR
    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

}

module.exports = PirCameraDriver;
