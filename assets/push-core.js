/* TWGI push notifications, browser side. Shared by Taskmaster and the Journal.
   Talks to the push Worker at PUSH_API with the signed-in Supabase access
   token (Authorization: Bearer). No cookies, no secrets in this file. The
   public VAPID key is fetched from /api/push/config.
   The permission prompt is only ever shown from enable(), which the page
   calls straight from a tap on "Enable notifications". */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TWGIPush = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (global) {
  var PUSH_API = 'https://push.theworldgovernmentincorporated.com';
  var DEVICE_KEY = 'twgi-push-device-v1';
  var IOS_HINT = 'On iPhone or iPad, notifications work only from the Home Screen app: tap Share, then Add to Home Screen, then open the app from its icon (iOS 16.4 or newer).';

  // Pure check, easy to test: { ok, reason, note }
  function support(env) {
    var agent = String(env.userAgent || '');
    var ios = /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && env.maxTouchPoints > 1);
    if (ios && !env.standalone) return { ok: false, reason: 'ios-install', note: IOS_HINT, ios: true };
    if (!env.serviceWorker || !env.pushManager || !env.notification) {
      return { ok: false, reason: 'unsupported', note: 'This browser cannot show notifications from this app.', ios: ios };
    }
    if (env.permission === 'denied') {
      return { ok: false, reason: 'denied', note: 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.', ios: ios };
    }
    return { ok: true, reason: '', note: '', ios: ios };
  }

  function currentEnv() {
    var nav = global.navigator || {};
    var media = typeof global.matchMedia === 'function' ? global.matchMedia('(display-mode: standalone)') : null;
    return {
      userAgent: nav.userAgent,
      maxTouchPoints: nav.maxTouchPoints || 0,
      standalone: !!(media && media.matches) || nav.standalone === true,
      serviceWorker: !!nav.serviceWorker,
      pushManager: 'PushManager' in global,
      notification: typeof global.Notification === 'function',
      permission: typeof global.Notification === 'function' ? global.Notification.permission : 'default'
    };
  }

  function urlBase64ToBytes(value) {
    var source = String(value || '');
    var padded = source.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - source.length % 4) % 4);
    var raw = global.atob(padded);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function deviceId() {
    try {
      var id = global.localStorage.getItem(DEVICE_KEY);
      if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
      id = global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      global.localStorage.setItem(DEVICE_KEY, id);
      return id;
    } catch (err) { return 'dev-unstored-' + Date.now().toString(36); }
  }

  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; }
    catch (err) { return 'America/New_York'; }
  }

  function flagKey(app, userId) { return 'twgi-push-on-v1:' + app + ':' + userId; }
  function isOn(app, userId) {
    try { return !!userId && global.localStorage.getItem(flagKey(app, userId)) === '1'; } catch (err) { return false; }
  }
  function setOn(app, userId, on) {
    try {
      if (on) global.localStorage.setItem(flagKey(app, userId), '1');
      else global.localStorage.removeItem(flagKey(app, userId));
    } catch (err) {}
  }

  async function accessToken() {
    var account = global.TWGIAccount;
    var client = account && account.client && account.client();
    if (!client) return '';
    var result = await client.auth.getSession();
    var session = result && result.data && result.data.session;
    return session && session.access_token ? session.access_token : '';
  }

  async function call(method, path, body) {
    var token = await accessToken();
    var headers = { accept: 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    if (body) headers['content-type'] = 'application/json';
    var response = await global.fetch(PUSH_API + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'omit'
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var err = new Error(data && data.error ? data.error : 'The notification service did not answer.');
      err.status = response.status;
      throw err;
    }
    return data;
  }

  // Must be called directly from a tap. Asks permission first, before any
  // network wait, so browsers treat it as a user gesture.
  async function enable(app, userId) {
    var check = support(currentEnv());
    if (!check.ok) return check;
    if (!userId) return { ok: false, reason: 'signin', note: 'Sign in first, then turn on notifications.' };
    var permission = await global.Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied', note: 'Notifications stay off until you allow them.' };
    var config = await call('GET', '/api/push/config');
    if (!config || !config.configured || !config.publicKey) {
      return { ok: false, reason: 'not-configured', note: 'The notification service is not switched on yet.' };
    }
    var registration = await global.navigator.serviceWorker.ready;
    var subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(config.publicKey) });
    }
    await call('POST', '/api/push/subscribe', { app: app, subscription: subscription.toJSON(), deviceId: deviceId(), tz: timeZone() });
    setOn(app, userId, true);
    return { ok: true, reason: '', note: 'Notifications are on for this device.' };
  }

  async function disable(app, userId) {
    setOn(app, userId, false);
    try {
      var registration = await global.navigator.serviceWorker.ready;
      var subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        try { await call('POST', '/api/push/unsubscribe', { app: app, endpoint: subscription.endpoint }); } catch (err) {}
        await subscription.unsubscribe();
      }
    } catch (err) {}
    return { ok: true, note: 'Notifications are off for this device.' };
  }

  return {
    PUSH_API: PUSH_API,
    IOS_HINT: IOS_HINT,
    support: support,
    currentEnv: currentEnv,
    currentSupport: function () { return support(currentEnv()); },
    urlBase64ToBytes: urlBase64ToBytes,
    deviceId: deviceId,
    timeZone: timeZone,
    isOn: isOn,
    setOn: setOn,
    enable: enable,
    disable: disable,
    settings: function (app) { return call('GET', '/api/push/settings?app=' + encodeURIComponent(app)); },
    saveSettings: function (app, body) { return call('POST', '/api/push/settings', Object.assign({ app: app }, body)); },
    sendTasks: function (tasks) { return call('POST', '/api/push/tasks', { app: 'taskmaster', deviceId: deviceId(), tasks: tasks }); },
    test: function (app) { return call('POST', '/api/push/test', { app: app }); },
    call: call
  };
});
