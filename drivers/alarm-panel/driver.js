'use strict';

const { Driver } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * AlarmPanelDriver
 *
 * Driver de la centrale d'alarme Verisure.
 * Une seule installation = un seul device (pas de liste multiple).
 *
 * Le pairing est simplifié : pas de nouvelle authentification requise
 * (la session a déjà été ouverte par le contact-sensor driver).
 * On liste directement l'installation disponible.
 */
class AlarmPanelDriver extends Driver {

  async onInit() {
    this.log('[AlarmPanelDriver] Init');

    // Flow trigger : alarme déclenchée
    this._triggerAlarmTriggered = this.homey.flow.getDeviceTriggerCard('alarm_triggered');

    // Trigger : état alarme changé
    this._triggerAlarmStateChanged = this.homey.flow.getDeviceTriggerCard('alarm_state_changed');

    // Flow condition : alarme armée (ancienne card — compatibilité)
    this.homey.flow.getConditionCard('is_alarm_armed')
      .registerRunListener(async ({ device }) => {
        const state = device.getCapabilityValue('verisure_alarm_state');
        return state && state !== 'disarmed';
      });

    // Flow condition : alarme dans un état précis
    this.homey.flow.getConditionCard('alarm_state_is')
      .registerRunListener(async ({ device, state }) => {
        return device.getCapabilityValue('verisure_alarm_state') === state;
      });

    // Flow action : définir l'état de l'alarme
    // Utilise triggerCapabilityListener pour déclencher le vrai ARM/DARM
    this.homey.flow.getActionCard('set_alarm_state')
      .registerRunListener(async ({ device, state }) => {
        return device.triggerCapabilityListener('verisure_alarm_state', state);
      });

    this.log('[AlarmPanelDriver] Flow triggers et conditions enregistrés');
  }

  // ---------------------------------------------------------------------------
  // Helper Flow — appelé depuis AlarmPanelDevice
  // ---------------------------------------------------------------------------

  async triggerAlarmTriggered(device, tokens) {
    await this._triggerAlarmTriggered.trigger(device, tokens);
  }

  async triggerAlarmStateChanged(device, tokens) {
    if (this._triggerAlarmStateChanged) {
      await this._triggerAlarmStateChanged.trigger(device, tokens).catch(e =>
        this.log('[AlarmPanelDriver] triggerAlarmStateChanged erreur:', e.message)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  /**
   * Liste les panneaux d'alarme disponibles (une installation = une centrale).
   * Requiert une session Verisure déjà enregistrée dans Homey settings.
   */
  async onPairListDevices() {
    this.log('[AlarmPanelDriver] onPairListDevices — vérification session...');

    // Vérifier que la session est active (configurée via les réglages de l'app)
    const hash    = this.homey.settings.get('verisure_auth_hash');
    const email   = this.homey.settings.get('verisure_email');
    const numinst = this.homey.settings.get('verisure_numinst');
    const pollerHash = this.homey.app?.poller?._client?._authHash;

    if (!hash && !pollerHash) {
      throw new Error(
        this.homey.__('error.no_session') ||
        'Aucune session Verisure active. Ouvrez les réglages de l\'application et connectez-vous d\'abord.'
      );
    }

    // Device déjà couplé → liste vide (list_devices affichera "déjà couplé")
    if (this.getDevices().length > 0) {
      this.log('[AlarmPanelDriver] Device déjà couplé');
      return [];
    }

    const giid    = this.homey.settings.get('verisure_giid')    || numinst || '';
    const panel   = this.homey.settings.get('verisure_panel')   || 'SDVFAST';
    const lastArm = this.homey.settings.get('verisure_last_arm_state') || 'DISARMED';
    const VerisureClient = require('../../lib/VerisureClient');

    this.log(`[AlarmPanelDriver] Session OK — numinst:${numinst} panel:${panel}`);

    return [
      {
        name: this.homey.__('device.alarm_panel_name') || 'Centrale Verisure',
        data: { id: 'alarm-panel-main' },
        settings: { giid, numinst, statusType: lastArm },
        capabilities: ['verisure_alarm_state', 'alarm_generic'],
        capabilityValues: {
          'verisure_alarm_state': VerisureClient.toVerisureAlarmState(lastArm),
          'alarm_generic': false,
        },
      },
    ];
  }

  
}

module.exports = AlarmPanelDriver;
