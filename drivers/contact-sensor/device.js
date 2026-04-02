'use strict';

const { Device } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * ContactSensorDevice
 *
 * Représente un capteur de contact Verisure (porte ou fenêtre) dans Homey.
 *
 * Capabilities déclarées dans app.json :
 *   - alarm_contact   (boolean) — true = ouvert, false = fermé
 *   - alarm_tamper    (boolean) — true = sabotage détecté
 *
 * Chaque device est identifié par son `deviceLabel` Verisure (ex: "1ABC2"),
 * stocké dans les settings du device lors du pairing.
 *
 * Le device ne poll pas lui-même — il s'abonne aux events du VerisurePoller
 * central géré par app.js. Cela garantit un unique appel API toutes les 10 min
 * quel que soit le nombre de capteurs couplés.
 */
class ContactSensorDevice extends Device {

  // ---------------------------------------------------------------------------
  // Cycle de vie Homey
  // ---------------------------------------------------------------------------

  async onInit() {
    const label = this.getSetting('deviceLabel');
    const area  = this.getSetting('area') || '';

    this.log(`[ContactSensor] Init — ${label} (${area})`);

    // Abonnement aux events du poller (via app.js)
    this._onContactChanged = this._onContactChanged.bind(this);
    this._onSessionExpired = this._onSessionExpired.bind(this);

    this.homey.app.poller.on('contact.changed', this._onContactChanged);
    this.homey.app.poller.on('session.expired', this._onSessionExpired);

    // Synchronisation initiale depuis le dernier état connu du poller
    await this._syncFromCache();

    // Initialiser measure_count si absent (premier démarrage)
    if (this.getCapabilityValue('measure_count') === null) {
      await this.setCapabilityValue('measure_count', 0).catch(() => {});
    }

    this.log(`[ContactSensor] Prêt — ${label} | ouvertures: ${this.getCapabilityValue('measure_count') || 0}`);
  }

  async onDeleted() {
    const label = this.getSetting('deviceLabel');
    this.log(`[ContactSensor] Suppression — ${label}`);

    // Nettoyage des listeners pour éviter les fuites mémoire
    if (this.homey.app.poller) {
      this.homey.app.poller.off('contact.changed', this._onContactChanged);
      this.homey.app.poller.off('session.expired', this._onSessionExpired);
    }
  }

  // ---------------------------------------------------------------------------
  // Synchronisation depuis le cache du poller
  // ---------------------------------------------------------------------------

  /**
   * Au démarrage, récupère l'état déjà connu du poller sans attendre
   * le prochain poll (évite un délai de 10 min après reboot Homey).
   */
  async _syncFromCache() {
    const label = this.getSetting('deviceLabel');
    const cachedState = this.homey.app.poller.getLastSensorState(label);

    if (cachedState === null) {
      // Le poller n'a pas encore tourné — on attend le premier event
      this.log(`[ContactSensor] ${label} — pas encore de cache, en attente du premier poll`);
      return;
    }

    const alarmContact = VerisureClient.toAlarmContact(cachedState);
    await this._setContactState(alarmContact, { silent: true });
    this.log(`[ContactSensor] ${label} — état initialisé depuis cache : ${cachedState}`);
  }

  // ---------------------------------------------------------------------------
  // Handlers d'événements poller
  // ---------------------------------------------------------------------------

  /**
   * Reçoit tous les changements de capteurs contact depuis le poller.
   * Filtre sur le deviceLabel de ce device.
   *
   * @param {{ deviceLabel: string, area: string, state: string, previous: string, alarmContact: boolean }} event
   */
  async _onContactChanged(event) {
    const label = this.getSetting('deviceLabel');

    // Ignorer les events des autres capteurs
    if (event.deviceLabel !== label) return;

    this.log(`[ContactSensor] ${label} — changement : ${event.previous} → ${event.state}`);

    await this._setContactState(event.alarmContact, { silent: false });

    // Mettre à jour le compteur d'ouvertures (CLOSE→OPEN uniquement)
    if (typeof event.openCount === 'number' && event.state === 'OPEN') {
      try {
        await this.setCapabilityValue('measure_open_count', event.openCount);
        this.log(`[ContactSensor] ${label} — compteur ouvertures : ${event.openCount}`);
      } catch(e) { this.error('[ContactSensor] measure_open_count:', e.message); }
    }
  }

  async _onSessionExpired() {
    const label = this.getSetting('deviceLabel');
    this.log(`[ContactSensor] ${label} — session expirée`);
    await this.setUnavailable(this.homey.__('error.session_expired') || 'Session Verisure expirée — reconnectez-vous dans les réglages.');
  }

  // ---------------------------------------------------------------------------
  // Mise à jour capability alarm_contact
  // ---------------------------------------------------------------------------

  /**
   * @param {boolean} alarmContact — true = ouvert, false = fermé
   * @param {{ silent: boolean }} options
   */
  async _setContactState(alarmContact, { silent = false } = {}) {
    try {
      const label   = this.getSetting('deviceLabel');
      const current = this.getCapabilityValue('alarm_contact');

      if (current === alarmContact) return;

      await this.setCapabilityValue('alarm_contact', alarmContact);

      // Remettre disponible si besoin
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

      if (!silent) {
        const tokens = { area: this.getSetting('area') || '', device: this.getName() };

        if (alarmContact) {
          // Incrémenter le compteur d'ouvertures (transition FERMÉ → OUVERT)
          const prev = this.getCapabilityValue('measure_count') || 0;
          await this.setCapabilityValue('measure_count', prev + 1).catch(() => {});
          this.log(`[ContactSensor] ${label} — ouvertures depuis reset: ${prev + 1}`);

          await this.driver.triggerContactOpened(this, tokens);
          this.log(`[ContactSensor] ${label} — Flow "contact_opened" déclenché`);
        } else {
          await this.driver.triggerContactClosed(this, tokens);
          this.log(`[ContactSensor] ${label} — Flow "contact_closed" déclenché`);
        }
      }

    } catch (err) {
      this.error('[ContactSensor] Erreur setCapabilityValue :', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Remise à zéro du compteur
  // ---------------------------------------------------------------------------

  async resetCount() {
    await this.setCapabilityValue('measure_count', 0);
    this.log(`[ContactSensor] ${this.getSetting('deviceLabel')} — compteur réinitialisé`);
  }

  // Settings & renommage
  // ---------------------------------------------------------------------------

  async onSettings({ changedKeys }) {
    this.log('[ContactSensor] Settings modifiés :', changedKeys);
  }

  async onRenamed(name) {
    this.log(`[ContactSensor] Renommé en : ${name}`);
  }

}

module.exports = ContactSensorDevice;
