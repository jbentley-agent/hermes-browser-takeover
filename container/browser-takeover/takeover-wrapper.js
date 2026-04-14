/**
 * Takeover wrapper for native @askjo/camoufox-browser server.
 * Uses module-load interception instead of forking server-camoufox.js.
 *
 * KEY FEATURE: Forces ALL requests to share a single browser context by
 * rewriting userId in every route handler. This ensures noVNC takeover 
 * sessions and agent sessions share cookies, auth state, and pages.
 *
 * HOW IT WORKS:
 * 1. Patches Express prototype methods (get/post/put/delete/patch) to wrap
 *    every handler with userId rewriting -> SHARED_USER_ID
 * 2. Blocks DELETE /sessions/:userId to prevent context destruction
 * 3. Disables the 60s session cleanup timer
 * 4. All agent tasks + noVNC see the same browser context
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

const SCREEN_WIDTH = parseInt(process.env.SCREEN_WIDTH || '1440', 10);
const SCREEN_HEIGHT = parseInt(process.env.SCREEN_HEIGHT || '900', 10);
const SCREEN_AVAIL_HEIGHT = parseInt(process.env.SCREEN_AVAIL_HEIGHT || String(Math.max(SCREEN_HEIGHT - 32, 1)), 10);
const CAPSOLVER_ADDON_PATH = process.env.CAPSOLVER_ADDON_PATH || '/root/capsolver-firefox-addon';
const DISPLAY = process.env.DISPLAY || ':99';

const SHARED_USER_ID = 'takeover_shared';

let _browserRef = null;

const originalLoad = Module._load;
const originalSetInterval = global.setInterval;

// ---------------------------------------------------------------------------
// Helper: wrap an Express route handler to rewrite userId
// ---------------------------------------------------------------------------
function wrapHandler(handler) {
  if (typeof handler !== 'function') return handler;
  return function wrappedHandler(req, res, ...rest) {
    if (req.body && req.body.userId != null) {
      req.body.userId = SHARED_USER_ID;
    }
    if (req.query && req.query.userId != null) {
      req.query.userId = SHARED_USER_ID;
    }
    if (req.params && req.params.userId != null) {
      req.params.userId = SHARED_USER_ID;
    }
    return handler.call(this, req, res, ...rest);
  };
}

function wrapHandlers(handlers) {
  return handlers.map(wrapHandler);
}

function patchedLaunchOptionsFactory(realModule) {
  const realLaunchOptions = realModule.launchOptions;
  return {
    ...realModule,
    launchOptions: async function patchedLaunchOptions(opts = {}) {
      opts = { ...opts, headless: false };
      const addons = Array.isArray(opts.addons) ? [...opts.addons] : [];
      try {
        if (fs.existsSync(path.join(CAPSOLVER_ADDON_PATH, 'manifest.json'))) {
          addons.push(CAPSOLVER_ADDON_PATH);
          console.log(`[takeover] CapSolver addon loaded from ${CAPSOLVER_ADDON_PATH}`);
        }
      } catch (_) {}
      opts.addons = addons;

      const options = await realLaunchOptions.call(realModule, opts);
      const camouKey = Object.keys(options.env || {}).find((k) => k.startsWith('CAMOU_CONFIG_'));
      if (camouKey) {
        try {
          const cfg = JSON.parse(options.env[camouKey]);
          Object.assign(cfg, {
            'screen.width': SCREEN_WIDTH,
            'screen.height': SCREEN_HEIGHT,
            'screen.availWidth': SCREEN_WIDTH,
            'screen.availHeight': SCREEN_AVAIL_HEIGHT,
            'window.outerWidth': SCREEN_WIDTH,
            'window.outerHeight': SCREEN_AVAIL_HEIGHT,
            'window.screenX': 0,
            'window.screenY': 0,
          });
          options.env[camouKey] = JSON.stringify(cfg);
        } catch (e) {
          console.warn(`[takeover] Failed to normalize ${camouKey}: ${e.message}`);
        }
      }
      options.env = {
        ...(options.env || {}),
        DISPLAY,
        MOZ_WEBRENDER: process.env.MOZ_WEBRENDER || '0',
        MOZ_X11_EGL: process.env.MOZ_X11_EGL || '0',
        LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE || '1',
      };
      options.firefoxUserPrefs = {
        ...(options.firefoxUserPrefs || {}),
        'gfx.webrender.all': false,
        'gfx.webrender.enabled': false,
        'layers.acceleration.disabled': true,
        'webgl.force-enabled': false,
        'webgl.disabled': true,
      };
      options.args = [
        ...(options.args || []).filter((a) => !a.startsWith('--width=') && !a.startsWith('--height=')),
        `--width=${SCREEN_WIDTH}`,
        `--height=${SCREEN_HEIGHT}`,
      ];
      console.log(`[takeover] Display normalized: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}`);
      return options;
    },
  };
}

Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);

  if (request === 'camoufox-js') {
    return patchedLaunchOptionsFactory(loaded);
  }

  if (request === 'playwright-core') {
    const pw = loaded;
    if (!pw.__takeover_patched__) {
      pw.__takeover_patched__ = true;
      const origLaunch = pw.firefox.launch;
      pw.firefox.launch = async function(...args) {
        const browser = await origLaunch.apply(this, args);
        _browserRef = browser;
        console.log('[takeover] Browser launch intercepted, tracking reference');
        browser.on('disconnected', () => {
          console.log('[takeover] Browser disconnected! Resetting server state...');
          _browserRef = null;
          const http = require('http');
          const r = http.request({ hostname: '127.0.0.1', port: process.env.PORT || 9377, path: '/stop', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {
            console.log('[takeover] Server reset via /stop, browser will re-launch on next request');
          });
          r.on('error', () => {});
          r.end('{}');
        });
        return browser;
      };
    }
    return pw;
  }

  if (request === 'express') {
    const express = loaded;

    if (!express.__takeover_patched__) {
      express.__takeover_patched__ = true;

      // =====================================================================
      // Wrap Express HTTP method registrations to rewrite userId
      // =====================================================================
      
      // For GET/PUT/PATCH: wrap handlers with userId rewriting
      for (const method of ['get', 'put', 'patch']) {
        const orig = express.application[method];
        express.application[method] = function(routePath, ...handlers) {
          if (typeof routePath === 'string') {
            return orig.call(this, routePath, ...wrapHandlers(handlers));
          }
          return orig.call(this, wrapHandler(routePath), ...wrapHandlers(handlers));
        };
      }

      // For POST: wrap handlers AND intercept POST /tabs to reuse existing tabs
      const origPostMethod = express.application.post;
      express.application.post = function(routePath, ...handlers) {
        if (typeof routePath === 'string' && routePath === '/tabs') {
          // Replace the native POST /tabs with our reuse-aware version
          console.log('[takeover] Intercepted POST /tabs registration — will reuse existing tabs');
          const nativeHandler = wrapHandlers(handlers).pop();
          return origPostMethod.call(this, routePath, async function(req, res) {
            // Rewrite userId (wrapHandler already does this but be explicit)
            if (req.body) req.body.userId = SHARED_USER_ID;

            // Check if there are already tabs for the shared user
            try {
              const http = require('http');
              const existingTabs = await new Promise((resolve) => {
                const proxyReq = http.request({
                  hostname: '127.0.0.1',
                  port: process.env.PORT || 9377,
                  path: `/tabs?userId=${SHARED_USER_ID}`,
                  method: 'GET',
                }, (proxyRes) => {
                  let data = '';
                  proxyRes.on('data', (chunk) => data += chunk);
                  proxyRes.on('end', () => {
                    try { resolve(JSON.parse(data).tabs || []); }
                    catch { resolve([]); }
                  });
                });
                proxyReq.on('error', () => resolve([]));
                proxyReq.end();
              });

              if (existingTabs.length > 0) {
                // Reuse the most recent existing tab
                const tab = existingTabs[existingTabs.length - 1];
                const tabId = tab.tabId || tab.targetId;
                console.log(`[takeover] Reusing existing tab ${tabId} (url: ${tab.url}) instead of creating new`);

                // If a URL was requested, navigate the existing tab to it
                const requestedUrl = req.body && req.body.url;
                if (requestedUrl && requestedUrl !== 'about:blank') {
                  try {
                    const navResult = await new Promise((resolve, reject) => {
                      const navReq = http.request({
                        hostname: '127.0.0.1',
                        port: process.env.PORT || 9377,
                        path: `/tabs/${tabId}/navigate`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                      }, (navRes) => {
                        let data = '';
                        navRes.on('data', (chunk) => data += chunk);
                        navRes.on('end', () => {
                          try { resolve(JSON.parse(data)); }
                          catch { resolve({ ok: true }); }
                        });
                      });
                      navReq.on('error', reject);
                      navReq.end(JSON.stringify({ userId: SHARED_USER_ID, url: requestedUrl }));
                    });
                    console.log(`[takeover] Navigated reused tab to ${requestedUrl}`);
                  } catch (e) {
                    console.log(`[takeover] Navigate failed, will create new tab: ${e.message}`);
                    return nativeHandler.call(this, req, res);
                  }
                }
                return res.json({ tabId, url: tab.url, reused: true });
              }
            } catch (e) {
              console.log(`[takeover] Tab reuse check failed: ${e.message}`);
            }

            // No existing tabs — fall through to native handler
            return nativeHandler.call(this, req, res);
          });
        }
        // All other POST routes: wrap normally
        if (typeof routePath === 'string') {
          return origPostMethod.call(this, routePath, ...wrapHandlers(handlers));
        }
        return origPostMethod.call(this, wrapHandler(routePath), ...wrapHandlers(handlers));
      };

      // For DELETE: wrap handlers AND block session/context destruction
      const origDeleteMethod = express.application.delete;
      express.application.delete = function(routePath, ...handlers) {
        if (typeof routePath === 'string' && routePath.includes('/sessions/')) {
          // Replace the session-close handler with a no-op that preserves context
          console.log('[takeover] Registered DELETE /sessions/:userId as NO-OP (shared context)');
          return origDeleteMethod.call(this, routePath, (req, res) => {
            const userId = req.params.userId || 'unknown';
            console.log(`[takeover] DELETE /sessions/${userId} blocked — shared context preserved`);
            res.json({ ok: true, shared: true, preserved: true });
          });
        }
        // All other DELETE routes: wrap normally
        if (typeof routePath === 'string') {
          return origDeleteMethod.call(this, routePath, ...wrapHandlers(handlers));
        }
        return origDeleteMethod.call(this, wrapHandler(routePath), ...wrapHandlers(handlers));
      };

      console.log('[takeover] All Express route methods wrapped for shared userId:', SHARED_USER_ID);

      // =====================================================================
      // Add takeover-specific routes at listen time
      // =====================================================================
      const origListen = express.application.listen;
      express.application.listen = function(...args) {

        this.get('/takeover/tabs', (req, res) => {
          const http = require('http');
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: process.env.PORT || 9377,
            path: `/tabs?userId=${SHARED_USER_ID}`,
            method: 'GET',
          }, (proxyRes) => {
            let data = '';
            proxyRes.on('data', (chunk) => data += chunk);
            proxyRes.on('end', () => {
              try {
                res.json({ ok: true, sharedUserId: SHARED_USER_ID, tabs: JSON.parse(data).tabs || [] });
              } catch (e) {
                res.json({ ok: true, sharedUserId: SHARED_USER_ID, tabs: [] });
              }
            });
          });
          proxyReq.on('error', () => res.json({ ok: true, sharedUserId: SHARED_USER_ID, tabs: [] }));
          proxyReq.end();
        });

        // Pin routes — no-ops in shared context mode but kept for MCP tool compat
        this.post('/takeover/pin-all', (req, res) => {
          console.log('[takeover] pin-all called (no-op in shared context mode)');
          res.json({ ok: true, mode: 'shared_context', hint: 'Pinning not needed — context is never destroyed' });
        });

        this.post('/takeover/pin', (req, res) => {
          res.json({ ok: true, mode: 'shared_context' });
        });

        this.delete('/takeover/pin-all', (req, res) => {
          res.json({ ok: true });
        });

        this.delete('/takeover/pin/:userId', (req, res) => {
          res.json({ ok: true });
        });

        this.get('/takeover/pin', (req, res) => {
          res.json({ pins: {}, pinAllUntil: null, mode: 'shared_context' });
        });

        this.get('/takeover/status', (req, res) => {
          res.json({
            ok: true,
            mode: 'shared_context',
            sharedUserId: SHARED_USER_ID,
            browserConnected: _browserRef ? _browserRef.isConnected() : false,
            hint: 'All agent tasks and noVNC share one browser context with cookies/auth.',
          });
        });

        console.log('[takeover] Shared context mode active — userId:', SHARED_USER_ID);
        return origListen.apply(this, args);
      };
    }

    return express;
  }

  return loaded;
};

// Disable the 60s session cleanup interval in shared mode
global.setInterval = function(callback, delay, ...args) {
  if (delay === 60000 || delay === 60_000) {
    console.log('[takeover] Session cleanup interval DISABLED (shared context mode)');
    return originalSetInterval.call(this, () => {}, 3600000);
  }
  return originalSetInterval.call(this, callback, delay, ...args);
};

console.log('[takeover] Loading native @askjo/camoufox-browser server...');
require('@askjo/camoufox-browser/server-camoufox.js');
