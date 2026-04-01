'use strict';

const { Device } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * AlarmPanelDevice
 *
 * Représente la centrale d'alarme Verisure dans Homey (device unique).
 *
 * Capabilities déclarées dans app.json :
 *   - homealarm_state      (enum) — 'armed' | 'partially_armed' | 'disarmed'  (Homey standard 3 états)
 *   - verisure_alarm_state (enum) — 'disarmed' | 'armed_away' | 'armed_day' | 'armed_night'
 *   - alarm_generic    (boolean) — true = alarme déclenchée en cours
 *
 * Comme ContactSensorDevice, ce device ne poll pas lui-même.
 * Il s'abonne aux events du VerisurePoller central géré par app.js.
 */
class AlarmPanelDevice extends Device {

  // ---------------------------------------------------------------------------
  // Cycle de vie Homey
  // ---------------------------------------------------------------------------

  async onInit() {
    this.log('[AlarmPanel] Init');

    // Supprimer homealarm_state si Homey l'a injecté automatiquement
    // (inévitable avec certaines versions du SDK même avec class: "other")
    if (this.hasCapability('homealarm_state')) {
      await this.removeCapability('homealarm_state').catch(e =>
        this.log('[AlarmPanel] removeCapability homealarm_state:', e.message)
      );
      this.log('[AlarmPanel] homealarm_state supprimé du device');
    }

    // S'assurer que verisure_alarm_state est bien présente
    if (!this.hasCapability('verisure_alarm_state')) {
      await this.addCapability('verisure_alarm_state').catch(e =>
        this.log('[AlarmPanel] addCapability verisure_alarm_state:', e.message)
      );
      this.log('[AlarmPanel] verisure_alarm_state ajoutée au device');
    }

    // Liaison des handlers pour pouvoir les détacher proprement dans onDeleted
    this._onAlarmChanged    = this._onAlarmChanged.bind(this);
    this._onSessionExpired  = this._onSessionExpired.bind(this);

    this.homey.app.poller.on('alarm.changed',   this._onAlarmChanged);
    this.homey.app.poller.on('session.expired', this._onSessionExpired);

    // Listener ARM/DARM : déclenché quand l'utilisateur change l'état depuis Homey
    // Listener de compatibilité homealarm_state (Homey peut l'injecter automatiquement)
    // Redirige vers verisure_alarm_state
    try {
      this.registerCapabilityListener('homealarm_state', async (value) => {
        this.log(`[AlarmPanel] homealarm_state → redirection vers verisure_alarm_state : ${value}`);
        const map = { 'armed': 'armed_away', 'partially_armed': 'armed_day', 'disarmed': 'disarmed' };
        const pin = this.getSetting('alarm_pin') || null;
        const targetState = { armed_away: 'ARMED_AWAY', armed_day: 'ARMED_DAY', disarmed: 'DISARMED' }[map[value]] || 'DISARMED';
        try {
          const client = this.homey.app.poller._client;
          if (!client) throw new Error('Client non disponible');
          const result = await client.setArmState(targetState, pin);
          const verisureState = VerisureClient.toVerisureAlarmState(result.statusType);
          await this.setCapabilityValue('verisure_alarm_state', verisureState).catch(e => this.error(e));
          if (this.homey.app?.poller) this.homey.app.poller._lastArmState = result.statusType;
          try { this.homey.settings.set('verisure_last_arm_state', result.statusType); } catch(e) { this.error(e); }
        } catch(err) { this.error('[AlarmPanel] homealarm_state erreur:', err.message); throw err; }
      });
    } catch(e) { this.log('[AlarmPanel] homealarm_state non disponible (normal si class=other)'); }

    // Listener 4 états via verisure_alarm_state
    this.registerCapabilityListener('verisure_alarm_state', async (value) => {
      this.log(`[AlarmPanel] verisure_alarm_state demandé : ${value}`);

      // Piste B : guard anti-doublon — ignorer si un ARM/DARM est déjà en cours
      if (this._armInProgress) {
        this.log(`[AlarmPanel] ARM/DARM déjà en cours — demande ignorée (${value})`);
        return true;
      }

      // Ignorer si l'état demandé est déjà l'état actuel
      const currentState = this.getCapabilityValue('verisure_alarm_state');
      if (currentState === value) {
        this.log(`[AlarmPanel] État déjà ${value} — demande ignorée`);
        return true;
      }

      this._armInProgress = true;
      const pin = this.getSetting('alarm_pin') || null;

      const stateMap = {
        'disarmed':    'DISARMED',
        'armed_away':  'ARMED_AWAY',
        'armed_day':   'ARMED_DAY',
        'armed_night': 'ARMED_NIGHT',
      };
      const targetState = stateMap[value] || 'DISARMED';

      try {
        const client = this.homey.app.poller._client;
        if (!client) throw new Error('Client Verisure non disponible');

        // Verisure ne permet pas de passer directement d'un mode armé à un autre.
        // Si l'alarme est déjà armée et qu'on demande un autre mode armé,
        // il faut d'abord désarmer puis réarmer.
        const currentIsArmed = currentState && currentState !== 'disarmed';
        const targetIsArmed  = value !== 'disarmed';

        if (currentIsArmed && targetIsArmed) {
          this.log(`[AlarmPanel] Transition armé→armé détectée (${currentState}→${value}) — désarmement intermédiaire`);

          // Étape 1 : désarmement rapide sans attendre la confirmation (évite le timeout 10s Homey)
          await this.setCapabilityValue('verisure_alarm_state', 'disarmed').catch(e => this.error(e));
          await client._disarmQuick(client._numinst, client._panel || 'SDVFAST');
          this.log('[AlarmPanel] Désarmement intermédiaire envoyé — pause 5s avant réarmement');

          // Pause de 5s pour laisser la centrale traiter le désarmement
          await new Promise(r => this.homey.setTimeout(r, 5000));
        }

        // Étape finale : armer dans le mode souhaité (ou juste désarmer si c'est 'disarmed')
        const result = await client.setArmState(targetState, pin);
        this.log(`[AlarmPanel] verisure_alarm_state OK — ${result.statusType}`);
        const verisureState = VerisureClient.toVerisureAlarmState(result.statusType);
        await this.setCapabilityValue('verisure_alarm_state', verisureState).catch(e => this.error(e));
        // Mettre à jour le cache poller et le setting immédiatement (sans attendre le prochain poll)
        if (this.homey.app?.poller) {
          this.homey.app.poller._lastArmState = result.statusType;
        }
        try { this.homey.settings.set('verisure_last_arm_state', result.statusType); } catch(e) { this.error(e); }
        return true;

      } catch (err) {
        this.error(`[AlarmPanel] verisure_alarm_state erreur: ${err.message}`);
        throw err;
      } finally {
        // Toujours libérer le verrou, même en cas d'erreur
        this._armInProgress = false;
      }
    });


    // Initialiser l'état depuis le cache ou forcer un poll
    const savedState = this.homey.app?.poller?.getStatus()?.lastArmState
                    || this.homey.settings.get('verisure_last_arm_state');

    if (savedState) {
      await this.setCapabilityValue('verisure_alarm_state', VerisureClient.toVerisureAlarmState(savedState)).catch(e => this.error(e));
      this.log(`[AlarmPanel] État initialisé : ${savedState} → ${VerisureClient.toVerisureAlarmState(savedState)}`);
    } else {
      // Pas de cache — forcer un poll puis mettre à jour la capability
      this.homey.setTimeout(async () => {
        try {
          await this.homey.app.poller.pollNow();
          // Après le poll, lire le nouvel état
          const freshState = this.homey.app?.poller?.getStatus()?.lastArmState
                          || this.homey.settings.get('verisure_last_arm_state');
          if (freshState) {
            await this.setCapabilityValue('verisure_alarm_state', VerisureClient.toVerisureAlarmState(freshState)).catch(e => this.error(e));
            this.log(`[AlarmPanel] État après poll : ${freshState} → ${VerisureClient.toVerisureAlarmState(freshState)}`);
          }
        } catch(e) { this.log('[AlarmPanel] pollNow erreur:', e.message); }
      }, 2000);
    }

    this.log('[AlarmPanel] Prêt');
  }

  async onDeleted() {
    this.log('[AlarmPanel] Suppression');

    if (this.homey.app.poller) {
      this.homey.app.poller.off('alarm.changed',   this._onAlarmChanged);
      this.homey.app.poller.off('session.expired', this._onSessionExpired);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync depuis le cache du poller
  // ---------------------------------------------------------------------------

  async _syncFromCache() {
    // 1. Essayer le cache mémoire du poller
    const status = this.homey.app.poller.getStatus();
    let armState = status.lastArmState;

    // 2. Fallback : lire le dernier état connu dans les settings
    if (!armState) {
      armState = this.homey.settings.get('verisure_last_arm_state') || null;
      if (armState) this.log(`[AlarmPanel] État depuis settings : ${armState}`);
    }

    if (!armState) {
      this.log('[AlarmPanel] Pas encore de cache, en attente du premier poll');
      return;
    }

    await this._setAlarmState(armState, { silent: true });
    this.log(`[AlarmPanel] État initialisé : ${armState} → ${VerisureClient.toVerisureAlarmState(armState)}`);
  }

  // ---------------------------------------------------------------------------
  // Handlers d'événements poller
  // ---------------------------------------------------------------------------

  /**
   * @param {{ statusType: string, homeyState: string, previous: string, date: string, changedVia: string }} event
   */
  async _onAlarmChanged(event) {
    this.log(`[AlarmPanel] Changement état : ${event.previous} → ${event.statusType}`);
    // Enrichir l'event avec l'état Verisure précédent pour les Flow tokens
    event.previousVerisureState = VerisureClient.toVerisureAlarmState(event.previous || 'DISARMED');
    await this._setAlarmState(event.statusType, { silent: false, event });
  }

  async _onSessionExpired() {
    this.log('[AlarmPanel] Session expirée — device indisponible');
    await this.setUnavailable(this.homey.__('error.session_expired') || 'Session Verisure expirée — reconnectez-vous dans les réglages.');
  }

  // ---------------------------------------------------------------------------
  // Mise à jour des capabilities
  // ---------------------------------------------------------------------------

  /**
   * @param {string} statusType — ex: 'ARMED_AWAY', 'ARMED_DAY', 'ARMED_NIGHT', 'DISARMED'
   * @param {{ silent: boolean, event?: object }} options
   */
  async _setAlarmState(statusType, { silent = false, event = null } = {}) {
    try {
      const verisureState = VerisureClient.toVerisureAlarmState(statusType);
      const current = this.getCapabilityValue('verisure_alarm_state');
      if (current === verisureState) return;

      await this.setCapabilityValue('verisure_alarm_state', verisureState).catch(e => this.error(e));

      // Remettre disponible si besoin
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

      if (!silent && event) {
        await this._triggerFlows(verisureState, event);
      }

    } catch (err) {
      this.error('[AlarmPanel] Erreur setCapabilityValue :', err.message);
    }
  }

  /**
   * Met à jour alarm_generic (alarme en cours).
   * @param {boolean} triggered
   */
  async _setAlarmTriggered(triggered) {
    try {
      const current = this.getCapabilityValue('alarm_generic');
      if (current === triggered) return;
      await this.setCapabilityValue('alarm_generic', triggered);
    } catch (err) {
      this.error('[AlarmPanel] Erreur alarm_generic :', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Flow triggers
  // ---------------------------------------------------------------------------

  async _triggerFlows(verisureState, event) {
    try {
      const previousState = event.previousVerisureState || '';
      const tokens = {
        state:          verisureState,
        previous_state: previousState,
        changed_via:    event.changedVia || '',
      };

      // Trigger "alarm_state_changed" — toujours
      await this.driver.triggerAlarmStateChanged(this, tokens);
      this.log(`[AlarmPanel] Flow "alarm_state_changed" déclenché : ${previousState} → ${verisureState}`);

      // Trigger "alarm_triggered" si l'alarme vient de se déclencher
      if (event.statusType === 'ALARM') {
        await this._setAlarmTriggered(true);
        await this.driver.triggerAlarmTriggered(this, tokens);
        this.log('[AlarmPanel] Flow "alarm_triggered" déclenché');
      } else {
        await this._setAlarmTriggered(false);
      }

    } catch (err) {
      this.error('[AlarmPanel] Erreur Flow trigger :', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings & renommage
  // ---------------------------------------------------------------------------

  // Appelé une seule fois juste après le pairing
  async onAdded() {
    this.log('[AlarmPanel] onAdded — initialisation état depuis settings');

    // Supprimer homealarm_state injecté automatiquement
    if (this.hasCapability('homealarm_state')) {
      await this.removeCapability('homealarm_state').catch(e =>
        this.log('[AlarmPanel] removeCapability homealarm_state:', e.message)
      );
    }
    if (!this.hasCapability('verisure_alarm_state')) {
      await this.addCapability('verisure_alarm_state').catch(e =>
        this.log('[AlarmPanel] addCapability verisure_alarm_state:', e.message)
      );
    }
    const savedState = this.homey.settings.get('verisure_last_arm_state');
    if (savedState) {
      await this.setCapabilityValue('verisure_alarm_state', VerisureClient.toVerisureAlarmState(savedState)).catch(e => this.error(e));
      await this.setCapabilityValue('alarm_generic', false).catch(e => this.error(e));
      this.log(`[AlarmPanel] onAdded — état initial : ${savedState} → ${homeyState}`);
    }
  }

  async onSettings({ changedKeys, newSettings }) {
    if (changedKeys.includes('alarm_pin')) {
      this.log('[AlarmPanel] Code PIN Verisure mis à jour');
    }
    this.log('[AlarmPanel] Settings modifiés :', changedKeys);
  }

  async onRenamed(name) {
    this.log(`[AlarmPanel] Renommé en : ${name}`);
  }

}

module.exports = AlarmPanelDevice;
