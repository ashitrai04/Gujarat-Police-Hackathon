import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadEnv } from 'vite'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const SENTINEL_ORIGIN = 'https://cctv.corp8.cloud'

/**
 * Dev-only sign-in against the camera grid.
 *
 * The key comes from .env (SENTINEL_ACCESS_KEY) and never reaches the browser:
 * the proxy attaches the resulting session cookie on the way out. Production
 * does the same thing in api/sentinel.js.
 */
async function signIn(): Promise<string> {
  const key =
    process.env.SENTINEL_ACCESS_KEY ||
    loadEnv('development', dirname, '').SENTINEL_ACCESS_KEY ||
    ''
  if (!key) throw new Error('SENTINEL_ACCESS_KEY missing from .env')
  const res = await fetch(`${SENTINEL_ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: key }).toString(),
    redirect: 'manual',
  })
  const lines =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const line of lines) {
    const m = /(?:^|;\s*)sentinel=([^;]+)/.exec(line)
    if (m) return `sentinel=${m[1]}`
  }
  throw new Error(`grid sign-in failed (${res.status}) — check SENTINEL_ACCESS_KEY`)
}

/**
 * Sign in before the server starts.
 *
 * http-proxy's `proxyReq` handler is synchronous — awaiting inside it sets the
 * header after the request has already gone out, which showed up as the grid
 * 302ing every call to /auth/login. Resolving the session here means the
 * cookie is always ready by the time a request needs it.
 */
const session = await signIn().catch((err: Error) => {
  console.error(`[sentinel] ${err.message} — camera feeds will not load`)
  return ''
})

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
       * The grid is behind an access key and serves HLS only. The proxy signs
       * in once, injects the session cookie, and rewrites the playlist's
       * absolute key URI (`URI="/enc.key"`) so hls.js fetches it back through
       * here instead of against the dev server's own root, where it would get
       * index.html and fail to decrypt.
       */
      '/sentinel': {
        target: SENTINEL_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/sentinel/, ''),
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            try {
              for (const h of [
                'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode',
                'sec-fetch-dest', 'sec-fetch-user', 'cookie',
              ]) proxyReq.removeHeader(h)
              if (session) proxyReq.setHeader('cookie', session)
            } catch {
              /* headers already flushed — nothing to scrub */
            }
          })

          proxy.on('proxyRes', (proxyRes, req, res) => {
            const chunks: Buffer[] = []
            proxyRes.on('data', (c) => chunks.push(c))
            proxyRes.on('end', () => {
              const body = Buffer.concat(chunks)
              const headers = { ...proxyRes.headers }
              delete headers['set-cookie']
              delete headers['content-encoding']
              delete headers['content-length']
              headers['access-control-allow-origin'] = '*'

              if (req.url?.includes('.m3u8')) {
                const text = body
                  .toString('utf8')
                  .replace(/URI="\/(?!\/)/g, 'URI="/sentinel/')
                  .replace(/^\/(?!\/)/gm, '/sentinel/')
                headers['content-type'] = 'application/vnd.apple.mpegurl'
                res.writeHead(proxyRes.statusCode ?? 200, headers)
                res.end(text)
                return
              }

              res.writeHead(proxyRes.statusCode ?? 200, headers)
              res.end(body)
            })
          })
        },
      },
    },
  },
})
