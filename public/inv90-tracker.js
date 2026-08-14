(function () {
  "use strict";

  var endpoint = "https://crm.breexe-pro.com/api/storefront/order-attribution";
  var storagePrefix = "inv90_attribution_";

  function cookie(name) {
    var prefix = name + "=";
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (part.indexOf(prefix) === 0) return decodeURIComponent(part.slice(prefix.length));
    }
    return "";
  }

  function gaClientId() {
    var value = cookie("_ga");
    var match = value.match(/^GA\d+\.\d+\.(\d+)\.(\d+)$/);
    return match ? match[1] + "." + match[2] : "";
  }

  function gaSessionId() {
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i += 1) {
      var pair = parts[i].trim().split("=");
      if (pair[0].indexOf("_ga_") !== 0) continue;
      var value = decodeURIComponent(pair.slice(1).join("="));
      var legacy = value.match(/^GS\d+\.\d+\.(\d+)/);
      if (legacy) return legacy[1];
      var current = value.match(/(?:^|[.$])s(\d{6,20})(?:[.$]|$)/);
      if (current) return current[1];
    }
    return "";
  }

  function safeSessionGet(key) {
    try { return window.sessionStorage.getItem(storagePrefix + key) || ""; } catch (_) { return ""; }
  }

  function safeSessionSet(key, value) {
    try { window.sessionStorage.setItem(storagePrefix + key, value); } catch (_) { /* no-op */ }
  }

  function captureCampaign() {
    if (!gaClientId()) return false;
    var params = new URLSearchParams(window.location.search || "");
    ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]
      .forEach(function (key) {
        var value = (params.get(key) || "").trim().slice(0, 200);
        if (value) safeSessionSet(key, value);
      });
    return true;
  }

  function payloadForOrder(payload) {
    var clientId = gaClientId();
    var total = payload && Number(payload.total);
    var currency = payload && String(payload.currency || "").trim().toUpperCase();
    if (!clientId || !payload || !payload.order_id || !Number.isFinite(total) || total <= 0 || currency !== "SAR") return null;
    return {
      order_id: String(payload.order_id).slice(0, 80),
      checkout_id: payload.checkout_id ? String(payload.checkout_id).slice(0, 100) : undefined,
      total: Math.round(total * 100) / 100,
      currency: currency,
      client_id: clientId,
      session_id: gaSessionId() || undefined,
      gclid: safeSessionGet("gclid") || undefined,
      gbraid: safeSessionGet("gbraid") || undefined,
      wbraid: safeSessionGet("wbraid") || undefined,
      utm_source: safeSessionGet("utm_source") || undefined,
      utm_medium: safeSessionGet("utm_medium") || undefined,
      utm_campaign: safeSessionGet("utm_campaign") || undefined,
      utm_content: safeSessionGet("utm_content") || undefined,
      utm_term: safeSessionGet("utm_term") || undefined
    };
  }

  function postAttribution(data, attempt) {
    var orderKey = "sent_" + data.order_id;
    if (safeSessionGet(orderKey) === "1") return;
    window.fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(data)
    }).then(function (response) {
      if (response.ok) {
        safeSessionSet(orderKey, "1");
        return;
      }
      if (attempt < 5 && (response.status === 404 || response.status === 409 || response.status === 503)) {
        window.setTimeout(function () { postAttribution(data, attempt + 1); }, Math.pow(2, attempt) * 1000);
      }
    }).catch(function () {
      if (attempt < 5) {
        window.setTimeout(function () { postAttribution(data, attempt + 1); }, Math.pow(2, attempt) * 1000);
      }
    });
  }

  if (!captureCampaign()) {
    var captureAttempt = 0;
    var captureTimer = window.setInterval(function () {
      captureAttempt += 1;
      if (captureCampaign() || captureAttempt >= 10) window.clearInterval(captureTimer);
    }, 500);
  }
  if (!window.Salla || typeof window.Salla.onReady !== "function") return;
  window.Salla.onReady(function () {
    if (!window.Salla.analytics || typeof window.Salla.analytics.registerTracker !== "function") return;
    window.Salla.analytics.registerTracker({
      name: "GoldenProINV90",
      track: function (eventName, payload) {
        if (eventName !== "Order Completed") return;
        var data = payloadForOrder(payload);
        if (data) postAttribution(data, 0);
      }
    });
  });
})();
