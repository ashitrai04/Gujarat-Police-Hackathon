import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const SENTINEL_ORIGIN = 'https://live.corp8.cloud'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(dirname, './src') },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      /**
       * Everything Sentinel goes through here. Two upstream quirks make a
       * direct browser fetch impossible:
       *
       *  1. /live/* returns `Access-Control-Allow-Origin: *` TWICE. Browsers
       *     reject that outright ("contains multiple values '*, *'").
       *  2. The origin 302s to itself with ?cookieCheck=1. Handed back to the
       *     browser, that lands on the origin directly and hits quirk 1 again.
       *
       * So: collapse the duplicate header, and rewrite Location so redirects
       * stay on the proxy. Cloudflare also serves a bot-challenge page when it
       * sees forwarded browser fetch-metadata, hence the header scrubbing.
       */
      '/sentinel': {
        target: SENTINEL_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/sentinel/, ''),
        headers: {
          'user-agent': 'curl/8.4.0',
          accept: '*/*',
        },
        // The origin issues a session cookie on index.m3u8 (?cookieCheck=1) and
        // then REQUIRES it on main_stream.m3u8 — without it the variant
        // playlist answers 401 "authentication error" and every tile stays
        // black. Rewrite the cookie onto this host so it survives the proxy.
        cookieDomainRewrite: '',
        cookiePathRewrite: '/sentinel',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            try {
              // NOTE: 'cookie' is deliberately NOT stripped — the stream
              // session depends on it. Only the fetch-metadata that trips
              // Cloudflare's bot challenge is removed.
              for (const h of [
                'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode',
                'sec-fetch-dest', 'sec-fetch-user', 'sec-ch-ua',
                'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept-language',
              ]) proxyReq.removeHeader(h)
            } catch {
              /* headers already flushed — nothing to scrub */
            }
          })
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['access-control-allow-origin'] = '*'
            delete proxyRes.headers['access-control-allow-credentials']

            // The origin sets `cookieCheck=1; Secure; SameSite=None; Partitioned`.
            // Those attributes stop the cookie sticking on plain http://localhost,
            // so the session is lost and the variant playlist answers 401. Strip
            // them for local dev.
            const sc = proxyRes.headers['set-cookie']
            if (Array.isArray(sc)) {
              proxyRes.headers['set-cookie'] = sc.map((c) =>
                c
                  .replace(/;\s*Secure/gi, '')
                  .replace(/;\s*Partitioned/gi, '')
                  .replace(/;\s*SameSite=None/gi, '; SameSite=Lax'),
              )
            }
            const loc = proxyRes.headers['location']
            if (typeof loc === 'string') {
              // Keep the redirect inside the proxy instead of bouncing the
              // browser to the origin.
              proxyRes.headers['location'] = loc
                .replace(SENTINEL_ORIGIN, '/sentinel')
                .replace('https://live.sentinelgujarat.in', '/sentinel')
            }
          })
        },
      },
    },
  },
})
