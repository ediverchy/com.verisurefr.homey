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
    this._initInProgress = false;

    // Marquer indisponible pendant l'init — force l'app mobile à recharger
    // le device complet (capabilities + values) une fois setAvailable() appelé
    // C'est ce qui se passe lors du cycle flows → retour dans l'app mobile
    await this.setUnavailable('Initialisation...').catch(e => this.error(e));

    // Supprimer homealarm_state si Homey l'a injecté automatiquement
    // (inévitable avec certaines versions du SDK même avec class: "other")
    // Supprimer alarm_generic et homealarm_state si présents (résidus de versions précédentes)
    for (const cap of ['alarm_generic', 'homealarm_state']) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch(e =>
          this.log(`[AlarmPanel] removeCapability ${cap}:`, e.message)
        );
        this.log(`[AlarmPanel] ${cap} supprimé du device`);
      }
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

    // ── 1. Enregistrer les listeners EN PREMIER ─────────────────────────────
    // Le listener doit exister avant le premier setCapabilityValue
    // sinon l'app mobile n'a pas les values disponibles au premier affichage

    // Listener de compatibilité homealarm_state
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
    // IMPORTANT : on retourne immédiatement pour ne pas bloquer l'UI Homey
    // L'ARM/DARM est exécuté en arrière-plan de façon asynchrone
    this.registerCapabilityListener('verisure_alarm_state', async (value) => {
      this.log(`[AlarmPanel] verisure_alarm_state demandé : ${value}`);

      // Ignorer pendant l'initialisation (setCapabilityValue depuis onInit)
      if (this._initInProgress) {
        this.log(`[AlarmPanel] Init en cours — listener ignoré (${value})`);
        return;
      }

      // Guard anti-doublon — ignorer si un ARM/DARM est déjà en cours
      if (this._armInProgress) {
        this.log(`[AlarmPanel] ARM/DARM déjà en cours — demande ignorée (${value})`);
        return;
      }

      // Ignorer si l'état demandé est déjà l'état actuel
      const currentState = this.getCapabilityValue('verisure_alarm_state');
      if (currentState === value) {
        this.log(`[AlarmPanel] État déjà ${value} — demande ignorée`);
        return;
      }

      // Mettre à jour l'UI immédiatement pour un retour visuel instantané
      await this.setCapabilityValue('verisure_alarm_state', value).catch(e => this.error(e));

      // Lancer l'ARM/DARM en arrière-plan sans bloquer le listener
      this._executeArmDarm(value, currentState).catch(err => {
        this.error(`[AlarmPanel] Erreur ARM/DARM arrière-plan : ${err.message}`);
        // En cas d'erreur, revenir à l'état précédent
        this.setCapabilityValue('verisure_alarm_state', currentState).catch(e => this.error(e));
      });
    });


    // ── 2. Initialiser la valeur APRÈS les listeners ────────────────────────
    // setCapabilityOptions d'abord pour que les values soient connues
    await this.setCapabilityOptions('verisure_alarm_state', {
      values: [
        { id: 'armed_day',   title: { en: 'Partial Day',   fr: 'Partiel Jour' } },
        { id: 'armed_night', title: { en: 'Partial Night', fr: 'Partiel Nuit' } },
        { id: 'armed_away',  title: { en: 'Total',         fr: 'Mode Total'   } },
        { id: 'disarmed',    title: { en: 'Disarmed',      fr: 'Désactivée'   } },
      ]
    }).catch(e => this.log('[AlarmPanel] setCapabilityOptions:', e.message));

    // Puis pousser la valeur courante
    const storeState   = this.getStoreValue('last_arm_state');
    const pollerState  = this.homey.app?.poller?.getStatus?.()?.lastArmState;
    const settingState = this.homey.settings.get('verisure_last_arm_state');
    const cachedState  = pollerState || storeState || settingState;

    this.log(`[AlarmPanel] Init states — store:${storeState} poller:${pollerState} setting:${settingState}`);

    if (cachedState) {
      const displayState = VerisureClient.toVerisureAlarmState(cachedState);
      this._initInProgress = true;
      await this.setCapabilityValue('verisure_alarm_state', displayState).catch(e => this.error(e));
      this._initInProgress = false;
      this.log(`[AlarmPanel] État initial affiché : ${cachedState} → ${displayState}`);
    }

    // ── 3. Marquer disponible en dernier ─────────────────────────────────────
    await this.setAvailable().catch(e => this.error(e));
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
      // Persister dans le store du device pour l'affichage initial au prochain démarrage
      await this.setStoreValue('last_arm_state', statusType).catch(e => this.error(e));

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
   * Exécute ARM/DARM en arrière-plan sans bloquer l'UI Homey.
   */
  async _executeArmDarm(value, currentState) {
    if (this._armInProgress) return;
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

      const currentIsArmed = currentState && currentState !== 'disarmed';
      const targetIsArmed  = value !== 'disarmed';

      if (currentIsArmed && targetIsArmed) {
        this.log(`[AlarmPanel] Transition armé→armé (${currentState}→${value}) — désarmement intermédiaire`);
        await client._disarmQuick(client._numinst, client._panel || 'SDVFAST');
        this.log('[AlarmPanel] Désarmement intermédiaire envoyé — pause 5s');
        await new Promise(r => this.homey.setTimeout(r, 5000));
      }

      const result = await client.setArmState(targetState, pin);
      this.log(`[AlarmPanel] ARM/DARM OK — ${result.statusType}`);
      const verisureState = VerisureClient.toVerisureAlarmState(result.statusType);
      await this.setCapabilityValue('verisure_alarm_state', verisureState).catch(e => this.error(e));

      if (this.homey.app?.poller) this.homey.app.poller._lastArmState = result.statusType;
      try { this.homey.settings.set('verisure_last_arm_state', result.statusType); } catch(e) { this.error(e); }

    } finally {
      this._armInProgress = false;
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

    // Supprimer alarm_generic et homealarm_state si présents
    for (const cap of ['alarm_generic', 'homealarm_state']) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch(e =>
          this.log(`[AlarmPanel] removeCapability ${cap}:`, e.message)
        );
      }
    }

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
      if (this.hasCapability('alarm_generic')) await this.setCapabilityValue('alarm_generic', false).catch(e => this.error(e));
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
