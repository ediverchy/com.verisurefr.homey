'use strict';

const { Device } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

// Délai d'attente entre la commande de capture et la récupération de l'image (ms)
const CAPTURE_WAIT_MS = 4000;

// Délai minimum entre deux captures manuelles pour éviter le rate limiting (ms)
const CAPTURE_COOLDOWN_MS = 30 * 1000;

/**
 * PirCameraDevice
 *
 * Représente un détecteur PIR avec caméra Verisure (GuardVision / SmartCam).
 *
 * Capabilities :
 *   - alarm_motion          (boolean) — true = mouvement détecté
 *   - homey:manager:images  (Image)   — dernière photo capturée
 *
 * La détection de mouvement est inférée depuis l'event log Verisure
 * lors du polling (pas de push natif disponible).
 *
 * La capture d'image est un workflow en 2 étapes :
 *   1. getCameraRequestId(deviceLabel)
 *   2. captureImage(deviceLabel, requestId)
 *   3. attendre ~4s
 *   4. getLastCameraImage(deviceLabel) → URL signée
 *   5. downloadImage(url) → Buffer → Homey Image
 */
class PirCameraDevice extends Device {

  // ---------------------------------------------------------------------------
  // Cycle de vie Homey
  // ---------------------------------------------------------------------------

  async onInit() {
    const label = this.getSetting('deviceLabel');
    const area  = this.getSetting('area') || '';
    this.log(`[PirCamera] Init — ${label} (${area})`);

    // Timestamp de la dernière capture pour le cooldown
    this._lastCaptureAt = 0;

    // Image Homey persistante — mise à jour à chaque capture
    this._cameraImage = await this.homey.images.createImage();

    // Abonnements aux events du poller
    this._onMotionChanged  = this._onMotionChanged.bind(this);
    this._onSessionExpired = this._onSessionExpired.bind(this);

    this.homey.app.poller.on('motion.changed',  this._onMotionChanged);
    this.homey.app.poller.on('session.expired', this._onSessionExpired);

    // Enregistrement de l'image Homey dans la capability (SDK3)
    try {
      await this.setCameraImage('front', this.homey.__('camera.front_label') || 'Caméra', this._cameraImage);
    } catch(e) {
      // setCameraImage peut ne pas être disponible selon la version SDK — non bloquant
      this.log('[PirCamera] setCameraImage non disponible (non bloquant) :', e.message);
    }

    // Initialiser measure_count si absent
    if (this.getCapabilityValue('measure_count') === null) {
      await this.setCapabilityValue('measure_count', 0).catch(() => {});
    }

    this.log(`[PirCamera] Prêt — ${label} | détections: ${this.getCapabilityValue('measure_count') || 0}`);
  }

  async onDeleted() {
    const label = this.getSetting('deviceLabel');
    this.log(`[PirCamera] Suppression — ${label}`);

    if (this.homey.app.poller) {
      this.homey.app.poller.off('motion.changed',  this._onMotionChanged);
      this.homey.app.poller.off('session.expired', this._onSessionExpired);
    }

    if (this._cameraImage) {
      await this._cameraImage.unregister().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Handler mouvement (depuis Poller)
  // ---------------------------------------------------------------------------

  /**
   * @param {{ deviceLabel: string, area: string, motionDetected: boolean }} event
   */
  async _onMotionChanged(event) {
    const label = this.getSetting('deviceLabel');
    if (event.deviceLabel !== label) return;

    this.log(`[PirCamera] ${label} — mouvement : ${event.motionDetected}`);
    await this._setMotionState(event.motionDetected);

    // Mettre à jour le compteur de mouvements (false→true uniquement)
    if (typeof event.motionCount === 'number' && event.motionDetected) {
      try {
        await this.setCapabilityValue('measure_motion_count', event.motionCount);
        this.log(`[PirCamera] ${label} — compteur mouvements : ${event.motionCount}`);
      } catch(e) { this.error('[PirCamera] measure_motion_count:', e.message); }
    }

    // Si mouvement détecté : déclencher automatiquement une capture
    if (event.motionDetected) {
      await this._autoCaptureOnMotion();
    }
  }

  async _onSessionExpired() {
    await this.setUnavailable(this.homey.__('error.session_expired') || 'Session Verisure expirée — reconnectez-vous dans les réglages.');
  }

  // ---------------------------------------------------------------------------
  // Mise à jour capability alarm_motion
  // ---------------------------------------------------------------------------

  async _setMotionState(motionDetected) {
    try {
      const current = this.getCapabilityValue('alarm_motion');
      if (current === motionDetected) return;

      await this.setCapabilityValue('alarm_motion', motionDetected);

      if (!this.getAvailable()) await this.setAvailable();

      if (motionDetected) {
        // Incrémenter le compteur de détections
        const prev = this.getCapabilityValue('measure_count') || 0;
        await this.setCapabilityValue('measure_count', prev + 1).catch(() => {});
        this.log(`[PirCamera] ${this.getSetting('deviceLabel')} — détections depuis reset: ${prev + 1}`);

        const tokens = { area: this.getSetting('area') || '', device: this.getName() };
        await this.driver.triggerMotionDetected(this, tokens);
        this.log(`[PirCamera] ${this.getSetting('deviceLabel')} — Flow "motion_detected" déclenché`);
      }

    } catch (err) {
      this.error('[PirCamera] Erreur setCapabilityValue alarm_motion :', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Capture d'image
  // ---------------------------------------------------------------------------

  /**
   * Capture déclenchée automatiquement lors d'un mouvement détecté.
   * Respecte le cooldown pour ne pas saturer l'API.
   */
  async _autoCaptureOnMotion() {
    const now = Date.now();
    if (now - this._lastCaptureAt < CAPTURE_COOLDOWN_MS) {
      this.log('[PirCamera] Capture auto ignorée — cooldown actif');
      return;
    }
    await this._doCapture({ source: 'motion' });
  }

  /**
   * Capture manuelle déclenchée depuis un Flow action ou la page device.
   * Expose une erreur lisible si la capture est refusée (droits insuffisants).
   *
   * @returns {Promise<boolean>}
   */
  async triggerCapture() {
    if (!this.getSetting('imageCaptureAllowed')) {
      throw new Error(this.homey.__('error.capture_not_allowed') || 'Capture non autorisée sur ce compte');
    }
    return this._doCapture({ source: 'manual' });
  }

  /**
   * Workflow complet de capture :
   * requestId → commande capture → attente → récupération URL → download → Homey Image.
   *
   * @param {{ source: 'motion'|'manual' }} opts
   * @returns {Promise<boolean>}
   */
  async _doCapture({ source }) {
    const label = this.getSetting('deviceLabel');
    this.log(`[PirCamera] Capture démarrée (source: ${source}) — ${label}`);

    try {
      // Instancier un client depuis la session persistée
      const client = VerisureClient.fromSettings({ homey: this.homey });

      // Workflow 2 étapes : requestId → capture → attente → image
      const image = await client.captureAndFetch(label, CAPTURE_WAIT_MS);

      if (!image || !image.imageUrl) {
        this.log('[PirCamera] Aucune image disponible après capture');
        return false;
      }

      this.log(`[PirCamera] Image disponible — captureTime: ${image.captureTime}`);

      // Téléchargement du binaire et mise à jour de l'Image Homey
      const buffer = await client.downloadImage(image.imageUrl);
      await this._updateHomeyImage(buffer, image.contentType || 'image/jpeg');

      this._lastCaptureAt = Date.now();

      // Flow trigger "image_captured"
      const tokens = {
        area:         this.getSetting('area') || '',
        device:       this.getName(),
        capture_time: image.captureTime || new Date().toISOString(),
      };
      await this.driver.triggerImageCaptured(this, tokens);
      this.log(`[PirCamera] Flow "image_captured" déclenché`);

      return true;

    } catch (err) {
      // Erreur 403 : droits insuffisants (compte secondaire sans accès caméra)
      if (err.message && err.message.includes('403')) {
        this.error('[PirCamera] 403 — droits insuffisants pour accéder aux images caméra');
        await this.setWarning(this.homey.__('error.capture_forbidden') || 'Droits insuffisants pour la caméra');
        return false;
      }

      this.error('[PirCamera] Erreur capture :', err.message);
      throw err;
    }
  }

  /**
   * Met à jour l'objet Image Homey avec le Buffer téléchargé.
   * Homey expose l'image dans l'app mobile et via l'API Timeline.
   *
   * @param {Buffer} buffer
   * @param {string} contentType
   */
  async _updateHomeyImage(buffer, contentType) {
    // SDK3 : setStream avec pipe du Buffer
    this._cameraImage.setStream(async (stream) => {
      const { Readable } = require('stream');
      const readable = new Readable();
      readable.push(buffer);
      readable.push(null);
      readable.pipe(stream);
    });

    // Notifie Homey que l'image a été mise à jour
    await this._cameraImage.update();
    this.log('[PirCamera] Image Homey mise à jour');
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async onSettings({ changedKeys }) {
    this.log('[PirCamera] Settings modifiés :', changedKeys);
  }

  async onRenamed(name) {
    this.log(`[PirCamera] Renommé en : ${name}`);
  }


  async resetCount() {
    await this.setCapabilityValue('measure_count', 0);
    this.log(`[PirCamera] ${this.getSetting('deviceLabel')} — compteur réinitialisé`);
  }

}

module.exports = PirCameraDevice;
