// sw.js — Trading Buddy service worker
// -----------------------------------------------------------------------
// Lets breakout alerts reach you even when this tab isn't open: once you
// tap "Enable Phone Alerts" on the page, the browser registers this file
// and it keeps running in the background (per the OS's own rules for
// background workers — see the in-app note about this).
//
// This file must live at the SITE ROOT (same folder as index.html), not
// inside netlify/functions, so its default scope covers the whole site.
// -----------------------------------------------------------------------

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A push message arrives from the server (see netlify/functions/check-alerts-cron.js)
// any time a watched ticker crosses its trigger price — this shows the
// native OS notification, even if no Trading Buddy tab is open.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Trading Buddy", body: event.data ? event.data.text() : "Price alert" };
  }

  const title = data.title || "Trading Buddy — Breakout Alert";
  const options = {
    body: data.body || "A watched ticker crossed its trigger price.",
    icon: data.icon || "/icon.png",
    badge: data.badge || "/icon.png",
    tag: data.tag || "breakout-alert",
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an existing Trading Buddy tab if one is
// open, or opens a new one otherwise.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
