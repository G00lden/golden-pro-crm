(function () {
  "use strict";

  var endpoint = "https://crm.breexe-pro.com/api/storefront/order-attribution";
  var claimEndpoint = "https://crm.breexe-pro.com/api/storefront/attribution-claim";
  var storagePrefix = "inv90_attribution_";
  var pendingClaims = {};

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

  function safeSessionRemove(key) {
    try { window.sessionStorage.removeItem(storagePrefix + key); } catch (_) { /* no-op */ }
  }

  function eventProperties(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (payload.properties && typeof payload.properties === "object") return payload.properties;
    return payload;
  }

  function checkoutIdFor(payload) {
    var properties = eventProperties(payload);
    var value = properties.checkout_id || properties.checkoutId || payload && (payload.checkout_id || payload.checkoutId);
    return value ? String(value).slice(0, 100) : "";
  }

  function eventScopeId(payload) {
    var properties = eventProperties(payload);
    var value = checkoutIdFor(payload) || properties.cart_id || properties.cartId;
    return value ? String(value).slice(0, 100) : "";
  }

  function safeMoney(value) {
    if (value === null || value === undefined || value === "") return undefined;
    var amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : undefined;
  }

  function ga4Items(payload) {
    var properties = eventProperties(payload);
    var products = Array.isArray(properties.products) ? properties.products : [];
    return products.slice(0, 200).map(function (product) {
      if (!product || typeof product !== "object") return null;
      var itemId = product.product_id || product.id || product.sku;
      var itemName = product.name || product.product_name;
      if (!itemId && !itemName) return null;
      var item = {};
      if (itemId) item.item_id = String(itemId).slice(0, 100);
      if (itemName) item.item_name = String(itemName).slice(0, 200);
      var price = safeMoney(product.price);
      var quantity = Number(product.quantity);
      if (price !== undefined) item.price = price;
      if (Number.isFinite(quantity) && quantity > 0) item.quantity = Math.round(quantity);
      return item;
    }).filter(Boolean);
  }

  function ga4CheckoutParams(payload) {
    var properties = eventProperties(payload);
    var params = {};
    var value = safeMoney(properties.value !== undefined ? properties.value : (properties.revenue !== undefined ? properties.revenue : properties.total));
    var currency = String(properties.currency || "").trim().toUpperCase();
    var items = ga4Items(payload);
    if (value !== undefined) params.value = value;
    if (/^[A-Z]{3}$/.test(currency)) params.currency = currency;
    if (items.length) params.items = items;
    return params;
  }

  function queueGa4Event(eventName, payload) {
    if (!gaClientId()) return false;
    var scopeId = eventScopeId(payload);
    if (!scopeId) return false;
    var sentKey = "ga4_" + eventName + "_" + scopeId;
    if (safeSessionGet(sentKey) === "1") return true;
    var params = ga4CheckoutParams(payload);
    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, params);
    } else if (window.dataLayer && typeof window.dataLayer.push === "function") {
      (function () { window.dataLayer.push(arguments); })("event", eventName, params);
    } else {
      return false;
    }
    safeSessionSet(sentKey, "1");
    return true;
  }

  function captureCampaign() {
    if (!gaClientId()) return false;
    var params = new URLSearchParams(window.location.search || "");
    var values = {};
    ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]
      .forEach(function (key) { values[key] = (params.get(key) || "").trim().slice(0, 200); });
    var source = String(values.utm_source || "").toLowerCase();
    var medium = String(values.utm_medium || "").toLowerCase().replace(/[ -]+/g, "_");
    if (source === "tiktok" || source === "tiktok.com" || source === "tik_tok") {
      values.utm_source = "tiktok";
      if (medium === "paid" || medium === "paid_social" || medium === "paidsocial" || medium === "cpc") {
        values.utm_medium = "paid";
      }
    }
    Object.keys(values).forEach(function (key) {
      if (values[key]) safeSessionSet(key, values[key]);
    });
    return true;
  }

  function attributionPayload(checkoutId) {
    var clientId = gaClientId();
    if (!clientId || !checkoutId) return null;
    var nonceKey = "claim_nonce_" + checkoutId;
    var claimNonce = safeSessionGet(nonceKey);
    if (!claimNonce) {
      if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return null;
      var bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      claimNonce = Array.prototype.map.call(bytes, function (value) {
        return value.toString(16).padStart(2, "0");
      }).join("");
      safeSessionSet(nonceKey, claimNonce);
    }
    return {
      checkout_id: String(checkoutId).slice(0, 100),
      claim_nonce: claimNonce,
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

  function reusableClaim(tokenKey) {
    var raw = safeSessionGet(tokenKey);
    if (!raw) return "";
    try {
      var saved = JSON.parse(raw);
      var expiresAt = Date.parse(String(saved.expires_at || ""));
      if (saved.token && Number.isFinite(expiresAt) && expiresAt > Date.now() + 30000) {
        return String(saved.token);
      }
    } catch (_) { /* Legacy plaintext tokens are deliberately renewed. */ }
    safeSessionRemove(tokenKey);
    return "";
  }

  function requestClaim(claim, tokenKey, attempt) {
    return window.fetch(claimEndpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(claim)
    }).then(function (response) {
      if (!response.ok) {
        if (attempt < 5 && (response.status === 429 || response.status >= 500)) {
          return new Promise(function (resolve) {
            window.setTimeout(resolve, Math.pow(2, attempt) * 1000);
          }).then(function () { return requestClaim(claim, tokenKey, attempt + 1); });
        }
        var rejected = new Error("Attribution claim was rejected.");
        rejected.noRetry = true;
        throw rejected;
      }
      return response.json().then(function (result) {
        var token = result && String(result.claim_token || "");
        if (!token) {
          var invalid = new Error("Attribution claim token is missing.");
          invalid.noRetry = true;
          throw invalid;
        }
        safeSessionSet(tokenKey, JSON.stringify({ token: token, expires_at: String(result.expires_at || "") }));
        return token;
      });
    }).catch(function (error) {
      if (attempt < 5 && !(error && error.noRetry)) {
        return new Promise(function (resolve) {
          window.setTimeout(resolve, Math.pow(2, attempt) * 1000);
        }).then(function () { return requestClaim(claim, tokenKey, attempt + 1); });
      }
      throw error;
    });
  }

  function claimForCheckout(checkoutId) {
    var normalized = checkoutId ? String(checkoutId).slice(0, 100) : "";
    if (!normalized) return Promise.reject(new Error("Checkout identifier is missing."));
    var tokenKey = "claim_token_" + normalized;
    var storedToken = reusableClaim(tokenKey);
    if (storedToken) return Promise.resolve(storedToken);
    if (pendingClaims[normalized]) return pendingClaims[normalized];
    var claim = attributionPayload(normalized);
    if (!claim) return Promise.reject(new Error("Consented attribution is unavailable."));
    pendingClaims[normalized] = requestClaim(claim, tokenKey, 0).finally(function () {
      delete pendingClaims[normalized];
    });
    return pendingClaims[normalized];
  }

  function payloadForOrder(payload, claimToken) {
    var properties = eventProperties(payload);
    var orderId = properties.order_id || properties.orderId || payload && (payload.order_id || payload.orderId);
    var checkoutId = checkoutIdFor(payload);
    var total = Number(properties.total);
    var currency = String(properties.currency || "").trim().toUpperCase();
    if (!orderId || !checkoutId || !claimToken || !Number.isFinite(total) || total <= 0 || currency !== "SAR") return null;
    return {
      order_id: String(orderId).slice(0, 80),
      checkout_id: checkoutId,
      claim_token: claimToken,
      total: Math.round(total * 100) / 100,
      currency: currency
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
        var checkoutId = checkoutIdFor(payload);
        if (eventName === "Checkout Step Viewed" || eventName === "Checkout Step Completed" || eventName === "Payment Info Entered") {
          if (checkoutId) claimForCheckout(checkoutId).catch(function () { /* retry on the next checkout event */ });
          if (eventName === "Checkout Step Completed") queueGa4Event("add_shipping_info", payload);
          if (eventName === "Payment Info Entered") queueGa4Event("add_payment_info", payload);
          return;
        }
        if (eventName !== "Order Completed" || !checkoutId) return;
        claimForCheckout(checkoutId).then(function (claimToken) {
          var data = payloadForOrder(payload, claimToken);
          if (data) postAttribution(data, 0);
        }).catch(function () { /* fail closed: never post an unsigned order */ });
      }
    });
  });
})();
