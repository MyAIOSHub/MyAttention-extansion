(function () {
  'use strict';

  var FIRST_OPEN_WELCOME_PENDING_KEY = 'first_open_welcome_pending';

  function setFirstOpenOverlayVisible(visible) {
    var overlay = document.getElementById('first-open-overlay');
    if (!overlay) {
      return;
    }

    if (
      !visible &&
      overlay.contains(document.activeElement) &&
      typeof document.activeElement.blur === 'function'
    ) {
      document.activeElement.blur();
    }

    overlay.hidden = !visible;
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function dismissFirstOpenOverlay() {
    setFirstOpenOverlayVisible(false);
    try {
      chrome.storage.local.set({ [FIRST_OPEN_WELCOME_PENDING_KEY]: false });
    } catch (_) {
      // Ignore storage failures. The overlay is still dismissed in this view.
    }
  }

  try {
    var manifest = chrome.runtime.getManifest();
    var versionBadge = document.getElementById('version-badge');
    if (versionBadge && manifest && manifest.version) {
      versionBadge.textContent = 'v' + manifest.version;
    }
  } catch (_) {
    // Version badge is best effort in fallback UI.
  }

  try {
    var closeButton = document.getElementById('first-open-overlay-close');
    if (closeButton) {
      closeButton.addEventListener('click', dismissFirstOpenOverlay);
    }
    chrome.storage.local.get([FIRST_OPEN_WELCOME_PENDING_KEY], function (result) {
      setFirstOpenOverlayVisible(result && result[FIRST_OPEN_WELCOME_PENDING_KEY] === true);
    });
  } catch (_) {
    // Fallback popup should remain usable even if extension APIs are unavailable.
  }
})();
