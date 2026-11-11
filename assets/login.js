/* Sign-in for an existing TWGI master account, inside the Taskmaster app.
   Same public Supabase project and flow as the main site's /login/.
   Returns to this app's own /login/ page. No service key is used. */
(function () {
  var SUPABASE_URL = 'https://xfswvbxuhgqbdqpqiywa.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_xHJ2V2lN-9B3LqSa3La3iw_QhqtU6JC';
  var AUTH_KEYS = [
    'code', 'error', 'error_code', 'error_description', 'error_uri', 'state',
    'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type',
    'type', 'provider_token', 'provider_refresh_token', 'token_hash', 'sb_flow_id'
  ];
  var form = document.getElementById('login-form');
  var status = document.getElementById('login-status');
  var sessionBox = document.getElementById('login-session');
  var who = document.getElementById('login-who');
  var out = document.getElementById('login-out');
  var emailInput = document.getElementById('login-email');
  var submit = document.getElementById('login-submit');
  var google = document.getElementById('login-google');

  function say(text) {
    if (status) status.textContent = text || '';
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function errorText(error) {
    return String((error && (error.message || error.error_description || error.code || error.name)) || '');
  }

  function message(error) {
    var text = errorText(error) || 'Something went wrong.';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'You appear to be offline. Try again when you are connected.';
    }
    if (/failed to fetch|networkerror|network request failed|load failed|offline|timeout/i.test(text)) {
      return 'You appear to be offline. Try again when you are connected.';
    }
    if (/signups not allowed|user not found|invalid login/i.test(text)) {
      return 'No account found for that email.';
    }
    return text;
  }

  function callbackMessage(error) {
    var text = errorText(error);
    var code = String((error && (error.code || error.name)) || '');
    var both = text + ' ' + code;
    if (/pkce_code_verifier_not_found|code verifier not found|AuthPKCECodeVerifierMissingError/i.test(both)) {
      return 'Open the sign-in link in the same browser, on the same device and profile, that asked for it.';
    }
    if (/expired|already used|already been used|invalid grant|otp_expired|flow state/i.test(both)) {
      return 'This sign-in link is expired or has already been used. Request a new one.';
    }
    return message(error);
  }

  function providerMessage(params) {
    var desc = String(params.error_description || '').replace(/\s+/g, ' ').trim();
    var code = String(params.error_code || params.error || '').trim();
    var both = desc + ' ' + code;
    if (/expired|already used|already been used|invalid grant|otp_expired/i.test(both)) {
      return 'This sign-in link is expired or has already been used. Request a new one.';
    }
    if (desc) return 'The sign-in provider returned an error: ' + desc.slice(0, 240);
    return 'The sign-in provider did not complete (' + (code || 'unknown error') + '). Request a new link.';
  }

  function googleMessage(error) {
    var text = errorText(error);
    if (/provider is not enabled|unsupported provider|validation_failed/i.test(text)) {
      return 'Google sign-in is not enabled for this project yet.';
    }
    if (/redirect/i.test(text) && /not allowed|invalid/i.test(text)) {
      return 'This site’s login address is not on the sign-in allow list yet.';
    }
    return message(error);
  }

  function readAuth() {
    var found = {};
    function take(raw) {
      var params = new URLSearchParams(raw);
      params.forEach(function (value, key) {
        if (AUTH_KEYS.indexOf(key) !== -1) found[key] = value;
      });
    }
    take(location.search.replace(/^\?/, ''));
    take(location.hash.charAt(0) === '#' ? location.hash.slice(1) : '');
    return found;
  }

  function scrubAuth() {
    var url = new URL(location.href);
    var changed = false;
    AUTH_KEYS.forEach(function (key) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });
    var hash = url.hash.charAt(0) === '#' ? url.hash.slice(1) : '';
    if (hash) {
      var hashParams = new URLSearchParams(hash);
      AUTH_KEYS.forEach(function (key) {
        if (hashParams.has(key)) {
          hashParams.delete(key);
          changed = true;
        }
      });
      var next = hashParams.toString();
      url.hash = next ? '#' + next : '';
    }
    if (changed) history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }

  function setReady(ready) {
    if (emailInput) emailInput.disabled = !ready;
    if (submit) submit.disabled = !ready;
    if (google) google.disabled = !ready;
  }

  function showSession(session) {
    var email = session && session.user && session.user.email;
    if (!email) {
      if (who) who.textContent = '';
      if (form) form.hidden = false;
      if (sessionBox) sessionBox.hidden = true;
      setReady(true);
      return;
    }
    if (form) form.hidden = true;
    if (sessionBox) sessionBox.hidden = false;
    setReady(false);
    if (who) who.textContent = 'Signed in as ' + email + '.';
  }

  var authParams = readAuth();
  var hasAuth = Object.keys(authParams).length > 0;

  if (!window.supabase || !window.supabase.createClient) {
    say('Sign-in is unavailable because the auth library did not load.');
    if (hasAuth) scrubAuth();
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      flowType: 'pkce'
    }
  });

  function finishCallback(session, errorText) {
    scrubAuth();
    if (errorText) say(errorText);
    if (session && session.user) showSession(session);
    else showSession(null);
  }

  var settled = false;
  var callback = Promise.resolve();
  if (authParams.error || authParams.error_description || authParams.error_code) {
    callback = Promise.resolve().then(function () {
      finishCallback(null, providerMessage(authParams));
    });
  } else if (authParams.code) {
    callback = client.auth.exchangeCodeForSession(authParams.code).then(function (result) {
      if (result.error) finishCallback(null, callbackMessage(result.error));
      else finishCallback(result.data && result.data.session, '');
    }).catch(function (err) {
      finishCallback(null, callbackMessage(err));
    });
  } else if (hasAuth) {
    callback = Promise.resolve().then(function () {
      scrubAuth();
      say('This sign-in return is not a supported code. Request a new link.');
      return client.auth.getSession();
    }).then(function (result) {
      if (!result) return;
      if (result.error) {
        showSession(null);
        return;
      }
      showSession(result.data.session);
    }).catch(function (err) {
      scrubAuth();
      say(message(err));
      showSession(null);
    });
  } else {
    callback = client.auth.getSession().then(function (result) {
      if (result.error) {
        say(message(result.error));
        showSession(null);
        return;
      }
      showSession(result.data.session);
    }).catch(function (err) {
      say(message(err));
      showSession(null);
    });
  }

  client.auth.onAuthStateChange(function (_event, session) {
    if (!settled) return;
    showSession(session);
  });

  callback.then(function () {
    settled = true;
    if (form && !form.hidden) setReady(true);
  });

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (submit && submit.disabled) return;
      var email = String(emailInput && emailInput.value || '').trim();
      if (!validEmail(email)) {
        say('Enter a valid email.');
        if (emailInput) emailInput.focus();
        return;
      }
      say('Sending a sign-in link… Open it in this same browser, on this device and profile.');
      if (submit) submit.disabled = true;
      client.auth.signInWithOtp({
        email: email,
        options: {
          emailRedirectTo: location.origin + '/login/',
          shouldCreateUser: false
        }
      }).then(function (result) {
        if (submit) submit.disabled = false;
        if (google) google.disabled = false;
        if (result.error) {
          say(message(result.error));
          return;
        }
        say('Check that email for a sign-in link. Open it in this same browser, on this device and profile.');
      }).catch(function (err) {
        if (submit) submit.disabled = false;
        if (google) google.disabled = false;
        say(message(err));
      });
    });
  }

  if (google) {
    google.addEventListener('click', function () {
      if (google.disabled) return;
      say('Continuing to Google…');
      google.disabled = true;
      if (submit) submit.disabled = true;
      client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: location.origin + '/login/'
        }
      }).then(function (result) {
        if (result.error) {
          google.disabled = false;
          if (submit) submit.disabled = false;
          say(googleMessage(result.error));
        }
      }).catch(function (err) {
        google.disabled = false;
        if (submit) submit.disabled = false;
        say(googleMessage(err));
      });
    });
  }

  if (out) {
    out.addEventListener('click', function () {
      client.auth.signOut({ scope: 'local' }).then(function (result) {
        showSession(null);
        say(result.error ? message(result.error) : 'Signed out.');
      }).catch(function (err) {
        showSession(null);
        say(message(err));
      });
    });
  }
})();
