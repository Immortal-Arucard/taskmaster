/* Master TWGI account session for the Taskmaster app.
   Same public Supabase project and publishable key as the main site.
   No service key. Reads only the signed-in user's own display name. */
(function () {
  var SUPABASE_URL = 'https://xfswvbxuhgqbdqpqiywa.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_xHJ2V2lN-9B3LqSa3La3iw_QhqtU6JC';
  var state = null;
  var settled = false;
  var listeners = [];
  var client = null;

  function httpsUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch (err) { return ''; }
  }

  function displayName(user, profile) {
    var stored = profile && String(profile.display_name || '').trim();
    if (stored) return stored;
    var meta = (user && user.user_metadata) || {};
    var email = String((user && user.email) || '').trim();
    var named = String(meta.full_name || meta.name || '').trim();
    if (named && named.toLowerCase() !== email.toLowerCase()) return named;
    return email.split('@')[0] || 'Account';
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function avatarNode(url, name) {
    var span = document.createElement('span');
    span.className = 'account-avatar';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = initials(name);
    if (!url) return span;
    var img = document.createElement('img');
    img.className = 'account-avatar';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.replaceChild(span, img);
    });
    return img;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function paint() {
    var slot = document.querySelector('[data-account-slot]');
    if (!slot) return;
    clear(slot);
    if (!settled) {
      var pending = document.createElement('span');
      pending.className = 'account-pending';
      pending.setAttribute('aria-label', 'Account');
      slot.appendChild(pending);
      return;
    }
    var link = document.createElement('a');
    link.href = '/login/';
    if (!state || !state.user) {
      link.textContent = 'Sign in';
      slot.appendChild(link);
      return;
    }
    link.setAttribute('aria-label', 'Account: ' + state.name);
    link.appendChild(avatarNode(state.avatarUrl, state.name));
    var name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = state.name;
    link.appendChild(name);
    slot.appendChild(link);
  }

  function apply(user, profile) {
    var meta = (user && user.user_metadata) || {};
    state = {
      user: user || null,
      name: user ? displayName(user, profile) : '',
      email: user && user.email ? String(user.email) : '',
      avatarUrl: user ? httpsUrl(meta.avatar_url || meta.picture) : ''
    };
    settled = true;
    paint();
    listeners.forEach(function (fn) { try { fn(state); } catch (err) {} });
  }

  async function refresh(user) {
    var profile = null;
    if (user && client) {
      try {
        var row = await client.from('master_profiles').select('display_name').eq('id', user.id).maybeSingle();
        if (row && !row.error && row.data) profile = row.data;
      } catch (err) {}
    }
    apply(user, profile);
  }

  window.TWGIAccount = {
    subscribe: function (fn) {
      listeners.push(fn);
      if (settled) fn(state);
    },
    signOut: function () {
      if (!client) return Promise.resolve();
      return client.auth.signOut({ scope: 'local' });
    },
    client: function () { return client; }
  };
  document.dispatchEvent(new CustomEvent('twgi-account-api'));
  paint();

  function boot() {
    if (!window.supabase || !window.supabase.createClient) { apply(null, null); return; }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, flowType: 'pkce' }
    });
    client.auth.getSession().then(function (result) {
      return refresh(result.data.session && result.data.session.user);
    }).catch(function () { apply(null, null); });
    client.auth.onAuthStateChange(function (_event, session) {
      if (!settled) return;
      refresh(session && session.user).catch(function () { apply(null, null); });
    });
  }

  if (window.supabase && window.supabase.createClient) boot();
  else {
    var lib = document.createElement('script');
    lib.src = '/vendor/supabase.js';
    lib.onload = boot;
    lib.onerror = function () { apply(null, null); };
    document.body.appendChild(lib);
  }
})();
