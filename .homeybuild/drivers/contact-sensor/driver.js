'use strict';

const { Driver } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * ContactSensorDriver
 *
 * Gère la découverte des capteurs Verisure lors du pairing
 * et enregistre les Flow triggers partagés par tous les devices du driver.
 *
 * Flow cards déclarées ici (à déclarer aussi dans app.json) :
 *   triggers : contact_opened, contact_closed
 */
class ContactSensorDriver extends Driver {

  async onInit() {
    this.log('[ContactSensorDriver] Init');

    // Enregistrement des Flow triggers
    this._triggerContactOpened = this.homey.flow.getDeviceTriggerCard('contact_opened');
    this._triggerContactClosed = this.homey.flow.getDeviceTriggerCard('contact_closed');

    // Action Flow : remettre le compteur à zéro
    this.homey.flow.getActionCard('contact_reset_count')
      .registerRunListener(async ({ device }) => {
        await device.resetCount();
      });

    this.log('[ContactSensorDriver] Flow triggers et actions enregistrés');
  }

  // ---------------------------------------------------------------------------
  // Helpers Flow — appelés depuis ContactSensorDevice
  // ---------------------------------------------------------------------------

  async triggerContactOpened(device, tokens) {
    await this._triggerContactOpened.trigger(device, tokens);
  }

  async triggerContactClosed(device, tokens) {
    await this._triggerContactClosed.trigger(device, tokens);
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  async onPairListDevices() {
    this.log('[ContactSensorDriver] Récupération liste capteurs...');

    // Utiliser le client du poller (session active avec cookies valides)
    if (!this.homey.app || !this.homey.app.poller || !this.homey.app.poller._client) {
      throw new Error('Session non disponible — connectez-vous dans les réglages d\'abord');
    }
    const client = this.homey.app.poller._client;
    this.log('[ContactSensorDriver] Client poller réutilisé');
    const sensors = await client.getDoorWindowSensors();

    if (!sensors.length) {
      throw new Error(this.homey.__('error.no_sensors_found'));
    }

    // Récupérer les devices déjà couplés pour les exclure
    const existingLabels = new Set(
      this.getDevices().map(d => d.getSetting('deviceLabel'))
    );

    const newDevices = sensors
      .filter(s => !existingLabels.has(s.deviceLabel))
      .map(sensor => ({
        name: sensor.area || sensor.deviceLabel,
        data: {
          id: sensor.deviceLabel,
        },
        settings: {
          deviceLabel: sensor.deviceLabel,
          area: sensor.area || '',
        },
        capabilities: ['alarm_contact', 'alarm_tamper'],
      }));

    this.log(`[ContactSensorDriver] ${newDevices.length} nouveau(x) capteur(s) trouvé(s)`);
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
    // Le template login_credentials passe { username, password }
    session.setHandler('login_credentials', async ({ username, password }) => {
      this.log('[ContactSensorDriver] Pairing — login_credentials');
      const email  = username;
      const client = new VerisureClient({ homey: this.homey, email, password });
      const phones = await client.initiateLogin(email, password);
      pendingClient = client;
      pendingEmail  = email;
      // Sauvegarder email et téléphones pour mfa.html
      await this.homey.settings.set('verisure_pending_email',  email);
      await this.homey.settings.set('verisure_pending_phones', JSON.stringify(
        phones.map(p => ({ id: p.index, phone: p.phone }))
      ));
      return true; // template login_credentials attend un boolean
    });

    // mfa.html — email pour affichage
    session.setHandler('get_email', async () => pendingEmail);

    // mfa.html — étape 2 : valide le code OTP
    session.setHandler('login_mfa', async ({ code }) => {
      this.log('[ContactSensorDriver] Pairing — login_mfa');
      if (!pendingClient) throw new Error('login_credentials doit être appelé avant login_mfa');
      await pendingClient.confirmMfa(code);
      pendingClient = null;
      pendingEmail  = null;
      await this.homey.app.poller.restart();
      return { ok: true };
    });

    // list_devices — liste les capteurs disponibles
    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

}

module.exports = ContactSensorDriver;
