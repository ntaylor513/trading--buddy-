// netlify/functions/_blobs.js
// -----------------------------------------------------------------------
// Shared helper for opening a Netlify Blobs store from a function.
//
// Netlify Functions are *supposed* to get their Blobs connection info
// (which site, which deploy) injected automatically, so plain
// `getStore("name")` just works. On some sites/deploys that automatic
// injection doesn't happen and every call fails with:
//   MissingBlobsEnvironmentError: The environment has not been
//   configured to use Netlify Blobs
// This file works around that by passing the connection info explicitly
// whenever it's available via env vars, and only falling back to the
// automatic (undocumented-to-fail) method if those aren't set.
//
// Needs two env vars in Netlify (Project configuration -> Environment
// variables) if your site hits the MissingBlobsEnvironmentError above:
//   BLOBS_SITE_ID   Project configuration -> General -> Site details ->
//                   Site ID (a UUID, already exists, just copy it)
//   BLOBS_TOKEN     A Personal Access Token: click your avatar (top
//                   right) -> User settings -> Applications -> Personal
//                   access tokens -> New access token. Any descriptive
//                   name, no special scopes needed beyond the default.
// If both of those are missing, this just calls the normal automatic
// getStore(name) — so adding this file alone doesn't break anything for
// a site where automatic configuration already works fine.
// -----------------------------------------------------------------------

const { getStore } = require("@netlify/blobs");

function getAlertStore(name) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  return getStore(name);
}

module.exports = { getAlertStore };
